// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

/*
The optional sync endpoint: a store of blobs it cannot read.

Everything a device sends is encrypted before it leaves, so the server validates
the envelope and nothing else. It checks that the sender's key fingerprint is the
slot being written, that the signature verifies under that key, that the counter
moves forward, and that the request carries a MAC proving membership of the
group. What is inside is the client's business -- `Share.parse` is the only thing
that has ever validated it, and keeping it that way means this file never learns
the transfer schema and a device running a three-week-old cached build cannot be
broken by a server upgrade.

The shape of access is what makes it a poor general-purpose store: slots are
replace-only, fixed in name and number, so a group's footprint is bounded however
often it is written. Unbounded storage would need unbounded groups, which is why
creating one is closed by default.
*/

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	syncEnvelopeVersion = 1
	maxBlob             = 2 << 20         // a bug-catcher, not a quota
	maxSlots            = 64              // devices in one group
	maxProfiles         = 256             // shares from one group
	pairTTL             = 5 * time.Minute // a pairing code is a moment, not a token
	slotIdle            = 2 * 365 * 24 * time.Hour
	defaultCeiling      = 5 << 30
	burst               = 20
	refill              = 5 * time.Second
)

var (
	idRe = regexp.MustCompile(`^[a-z2-7]{26}$`)
	b32  = base32.StdEncoding.WithPadding(base32.NoPadding)
	b64  = base64.StdEncoding
)

// SyncOptions configures the endpoint. Zero disables it entirely.
type SyncOptions struct {
	Dir     string // where blobs live; must not be inside the site output
	Invite  string // presenting this creates a group
	Open    bool   // anybody may create one, and no invite is asked for
	Ceiling int64  // bytes on disk before writes are refused
	Log     io.Writer
}

/*
What a browser is told before it asks for anything, so that setting sync up

	can ask for an address and stop there. An endpoint that wants no secret should
	not make somebody find out by being refused. Nothing here is a secret: it is
	the difference between a door that is open, a door with a bell, and a wall.
*/
func (s *syncStore) policy() string {
	switch {
	case s.opt.Open:
		return "open"
	case strings.TrimSpace(s.opt.Invite) != "":
		return "invite"
	default:
		return "closed"
	}
}

type syncStore struct {
	opt   SyncOptions
	mu    sync.Mutex
	rate  map[string]*bucket
	bytes int64
	sized bool
}

type bucket struct {
	tokens float64
	seen   time.Time
}

type groupMeta struct {
	Auth    string `json:"auth"` // base64 enrolment key, for the membership MAC
	Created string `json:"created"`
}

type pairRec struct {
	Group   string          `json:"group"`
	Key     string          `json:"key"` // base64 pairing key, for that MAC
	Created string          `json:"created"`
	A       json.RawMessage `json:"a,omitempty"`
	B       json.RawMessage `json:"b,omitempty"`
}

type profileRec struct {
	Group string          `json:"group"`
	Read  string          `json:"read"` // base64 read key, for the viewer's MAC
	Env   json.RawMessage `json:"env"`
}

// envelope is what the server understands. `Ct` is opaque.
type envelope struct {
	V       int    `json:"v"`
	Slot    string `json:"slot"`
	Key     string `json:"key"`
	Counter int64  `json:"counter"`
	Written string `json:"written"`
	N       string `json:"n"`
	Ct      string `json:"ct"`
	Sig     string `json:"sig"`
	Recv    string `json:"recv,omitempty"` // stamped here, never by the sender
}

/*
The one thing a clock-skewed device cannot forge. Merges compare times across

	devices, and a machine a year fast would otherwise win every last-write-wins
	comparison until somebody noticed.
*/
func stamp() string { return time.Now().UTC().Format(time.RFC3339) }

func (s *syncStore) logf(format string, a ...any) {
	if s.opt.Log != nil {
		fmt.Fprintf(s.opt.Log, format+"\n", a...)
	}
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

/*
Blobs are handed back as something no browser will render or execute. They are

	JSON to the client that asked for them and an attachment to everything else,
	which closes off the only reason anybody would want somebody else's endpoint.
*/
func sendBlob(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

func (s *syncStore) groupDir(id string) string { return filepath.Join(s.opt.Dir, "g", id) }
func (s *syncStore) slotPath(g, fp string) string {
	return filepath.Join(s.groupDir(g), "s", fp+".json")
}
func (s *syncStore) pairPath(p string) string { return filepath.Join(s.opt.Dir, "pr", p+".json") }
func (s *syncStore) profilePath(id string) string {
	return filepath.Join(s.opt.Dir, "pf", id+".json")
}

func readSync(path string, into any) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, into)
}

/*
Written whole and moved into place, so a reader never sees half a blob and a

	crash mid-write leaves the previous version rather than a broken one.
*/
func writeSync(path string, v any) error {
	if e := os.MkdirAll(filepath.Dir(path), 0o755); e != nil {
		return e
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	tmp := path + ".tmp"
	if e := os.WriteFile(tmp, b, 0o600); e != nil {
		return e
	}
	return os.Rename(tmp, path)
}

// ---- membership -------------------------------------------------------------

/*
The MAC that says "this request comes from somebody holding the group key".

	It covers the method, the path and the body, so it cannot be moved from one
	request to another. The counter is not in it: replay of a write is already
	impossible because the counter inside the signed envelope has to move.
*/
func macOver(key []byte, method, path string, body []byte) string {
	sum := sha256.Sum256(body)
	m := hmac.New(sha256.New, key)
	fmt.Fprintf(m, "hypnotica/auth/1\n%s\n%s\n%x", method, path, sum)
	return b64.EncodeToString(m.Sum(nil))
}

func checkMAC(key []byte, given, method, path string, body []byte) bool {
	want := macOver(key, method, path, body)
	return subtle.ConstantTimeCompare([]byte(want), []byte(given)) == 1
}

func (s *syncStore) group(id string) (*groupMeta, []byte, bool) {
	if !idRe.MatchString(id) {
		return nil, nil, false
	}
	var m groupMeta
	if e := readSync(filepath.Join(s.groupDir(id), "meta.json"), &m); e != nil {
		return nil, nil, false
	}
	key, e := b64.DecodeString(m.Auth)
	if e != nil || len(key) < 16 {
		return nil, nil, false
	}
	return &m, key, true
}

// ---- envelopes ---------------------------------------------------------------

/*
What the fingerprint of a public key is, and therefore what slot it may write.

	A write is self-authenticating: no registration step, no account, and no
	record on this side of who a device is beyond the name it proves.
*/
func fingerprint(spki []byte) string {
	sum := sha256.Sum256(spki)
	return strings.ToLower(b32.EncodeToString(sum[:16]))
}

func signedOver(scope, slot string, counter int64, ct []byte) []byte {
	sum := sha256.Sum256(ct)
	return []byte(fmt.Sprintf("hypnotica/env/1\n%s\n%s\n%d\n%x", scope, slot, counter, sum))
}

/* WebCrypto signs P-256 as a raw r||s pair; Go wants the two halves. */
func verifySig(pub *ecdsa.PublicKey, msg, sig []byte) bool {
	if len(sig) != 64 {
		return false
	}
	h := sha256.Sum256(msg)
	r := new(big.Int).SetBytes(sig[:32])
	sv := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(pub, h[:], r, sv)
}

// checkEnvelope validates everything the server can, and nothing it cannot.
func checkEnvelope(env *envelope, scope, slot string, held int64) error {
	if env.V != syncEnvelopeVersion {
		return fmt.Errorf("envelope version %d is not understood", env.V)
	}
	if env.Slot != slot {
		return fmt.Errorf("envelope names a different slot")
	}
	spki, e := b64.DecodeString(env.Key)
	if e != nil {
		return fmt.Errorf("public key is not base64")
	}
	if fingerprint(spki) != slot {
		return fmt.Errorf("key does not name this slot")
	}
	any, e := x509.ParsePKIXPublicKey(spki)
	if e != nil {
		return fmt.Errorf("public key is unreadable")
	}
	pub, okay := any.(*ecdsa.PublicKey)
	if !okay || pub.Curve != elliptic.P256() {
		return fmt.Errorf("public key is not P-256")
	}
	ct, e := b64.DecodeString(env.Ct)
	if e != nil {
		return fmt.Errorf("ciphertext is not base64")
	}
	if len(ct) == 0 {
		return fmt.Errorf("ciphertext is empty")
	}
	sig, e := b64.DecodeString(env.Sig)
	if e != nil {
		return fmt.Errorf("signature is not base64")
	}
	if !verifySig(pub, signedOver(scope, slot, env.Counter, ct), sig) {
		return fmt.Errorf("signature does not verify")
	}
	if env.Counter <= held {
		return fmt.Errorf("counter %d does not follow %d", env.Counter, held)
	}
	return nil
}

// ---- quotas ------------------------------------------------------------------

/*
Sustained one write every few seconds with a generous burst. A library is not

	public and everybody who can reach this was linked on purpose, so the limit is
	here to catch a loop, not an adversary.
*/
func (s *syncStore) allow(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	b := s.rate[key]
	if b == nil {
		b = &bucket{tokens: burst, seen: now}
		s.rate[key] = b
	}
	b.tokens += now.Sub(b.seen).Seconds() / refill.Seconds()
	if b.tokens > burst {
		b.tokens = burst
	}
	b.seen = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (s *syncStore) ceiling() int64 {
	if s.opt.Ceiling > 0 {
		return s.opt.Ceiling
	}
	return defaultCeiling
}

func (s *syncStore) roomFor(n int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sized {
		var total int64
		_ = filepath.Walk(s.opt.Dir, func(_ string, info os.FileInfo, e error) error {
			if e == nil && info != nil && !info.IsDir() {
				total += info.Size()
			}
			return nil
		})
		s.bytes, s.sized = total, true
	}
	if s.bytes+n > s.ceiling() {
		return false
	}
	s.bytes += n
	return true
}

func countIn(dir string) int {
	entries, e := os.ReadDir(dir)
	if e != nil {
		return 0
	}
	n := 0
	for _, x := range entries {
		if strings.HasSuffix(x.Name(), ".json") {
			n++
		}
	}
	return n
}

/*
Pairing records are a few minutes old at most, and slots nobody has written to

	in two years belong to a device that is gone. Neither is worth a scheduler:
	the first is swept whenever its group is touched, the second at startup.
*/
func (s *syncStore) sweepPairs() {
	dir := filepath.Join(s.opt.Dir, "pr")
	entries, e := os.ReadDir(dir)
	if e != nil {
		return
	}
	for _, x := range entries {
		info, e := x.Info()
		if e == nil && time.Since(info.ModTime()) > pairTTL {
			_ = os.Remove(filepath.Join(dir, x.Name()))
		}
	}
}

func (s *syncStore) sweepIdle() {
	groups, e := os.ReadDir(filepath.Join(s.opt.Dir, "g"))
	if e != nil {
		return
	}
	for _, g := range groups {
		dir := filepath.Join(s.opt.Dir, "g", g.Name(), "s")
		slots, e := os.ReadDir(dir)
		if e != nil {
			continue
		}
		for _, x := range slots {
			info, e := x.Info()
			if e == nil && time.Since(info.ModTime()) > slotIdle {
				_ = os.Remove(filepath.Join(dir, x.Name()))
				s.logf("sync: dropped idle slot %s/%s", g.Name(), x.Name())
			}
		}
	}
}

// ---- the handler --------------------------------------------------------------

// SyncHandler serves the endpoint, or nil when no directory is configured.
func SyncHandler(opt SyncOptions) http.Handler {
	if strings.TrimSpace(opt.Dir) == "" {
		return nil
	}
	s := &syncStore{opt: opt, rate: map[string]*bucket{}}
	_ = os.MkdirAll(opt.Dir, 0o755)
	s.sweepIdle()
	s.sweepPairs()
	return http.HandlerFunc(s.serve)
}

/*
The endpoint answers from any origin. Nothing here is authorised by a cookie

	-- every request carries a MAC derived from a key the server was handed -- so
	a wildcard gives a browser on another origin no power a scripted client did
	not already have, and it lets the site be hosted somewhere other than this.
*/
func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
	h.Set("Access-Control-Allow-Headers",
		"Content-Type, X-Hypnotica-Auth, X-Hypnotica-Pair, X-Hypnotica-Read, X-Hypnotica-Invite, X-Hypnotica-Group")
	h.Set("Access-Control-Max-Age", "600")
}

func (s *syncStore) serve(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.logf("sync: %s %s", r.Method, r.URL.Path)
	switch {
	case r.URL.Path == "/sync/" || r.URL.Path == "/sync":
		if r.Method != http.MethodGet {
			fail(w, http.StatusMethodNotAllowed, "not a method for the endpoint itself")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hypnotica": syncEnvelopeVersion, "create": s.policy(), "now": stamp()})
	case strings.HasPrefix(r.URL.Path, "/sync/"):
		s.serveSync(w, r)
	case strings.HasPrefix(r.URL.Path, "/pair/"):
		s.servePair(w, r)
	case strings.HasPrefix(r.URL.Path, "/profile/"):
		s.serveProfile(w, r)
	default:
		fail(w, http.StatusNotFound, "no such endpoint")
	}
}

// body reads at most one blob's worth, and says so rather than truncating.
func body(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, e := io.ReadAll(io.LimitReader(r.Body, maxBlob+1))
	if e != nil {
		fail(w, http.StatusBadRequest, "could not read the request")
		return nil, false
	}
	if len(b) > maxBlob {
		fail(w, http.StatusRequestEntityTooLarge, "larger than this endpoint accepts")
		return nil, false
	}
	return b, true
}

func (s *syncStore) serveSync(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/sync/")
	parts := strings.SplitN(rest, "/", 2)
	gid := parts[0]
	tail := ""
	if len(parts) > 1 {
		tail = parts[1]
	}
	if !idRe.MatchString(gid) {
		fail(w, http.StatusNotFound, "no such group")
		return
	}
	raw, okay := body(w, r)
	if !okay {
		return
	}

	// Creating a group is the only thing the group key cannot authorise, because
	// the server has not been given it yet. An invite is what stands in, and with
	// no invite configured there are no new groups at all.
	if tail == "" && r.Method == http.MethodPost {
		s.createGroup(w, r, gid, raw)
		return
	}

	_, key, known := s.group(gid)
	if !known {
		fail(w, http.StatusNotFound, "no such group")
		return
	}
	if !checkMAC(key, r.Header.Get("X-Hypnotica-Auth"), r.Method, r.URL.Path, raw) {
		fail(w, http.StatusForbidden, "not a member of this group")
		return
	}

	switch {
	case tail == "" || tail == "/":
		if r.Method != http.MethodGet {
			fail(w, http.StatusMethodNotAllowed, "not a method for a group")
			return
		}
		s.listSlots(w, gid)
	case tail == "pair":
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, "not a method for pairing")
			return
		}
		s.offerPair(w, gid, raw)
	default:
		s.slot(w, r, gid, tail, raw)
	}
}

func (s *syncStore) createGroup(w http.ResponseWriter, r *http.Request, gid string, raw []byte) {
	switch s.policy() {
	case "closed":
		fail(w, http.StatusForbidden, "this endpoint is not taking new libraries")
		return
	case "invite":
		if subtle.ConstantTimeCompare([]byte(s.opt.Invite),
			[]byte(r.Header.Get("X-Hypnotica-Invite"))) != 1 {
			fail(w, http.StatusForbidden, "that invite is not this one")
			return
		}
	}
	// Open or not, creating a group is the one unbounded thing here, so it is
	// paced. A person links a device once; a loop does it as fast as it can.
	if !s.allow("create") {
		fail(w, http.StatusTooManyRequests, "new libraries are arriving faster than expected")
		return
	}
	if _, _, known := s.group(gid); known {
		fail(w, http.StatusConflict, "that group is already here")
		return
	}
	var in struct {
		Auth string `json:"auth"`
	}
	if e := json.Unmarshal(raw, &in); e != nil {
		fail(w, http.StatusBadRequest, "not JSON")
		return
	}
	key, e := b64.DecodeString(in.Auth)
	if e != nil || len(key) < 16 {
		fail(w, http.StatusBadRequest, "no usable enrolment key")
		return
	}
	if e := writeSync(filepath.Join(s.groupDir(gid), "meta.json"),
		groupMeta{Auth: in.Auth, Created: stamp()}); e != nil {
		fail(w, http.StatusInternalServerError, "could not write the group")
		return
	}
	s.logf("sync: group %s created", gid)
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"group": gid, "created": stamp()})
}

type slotRow struct {
	Slot    string `json:"slot"`
	Counter int64  `json:"counter"`
	Recv    string `json:"recv"`
	Bytes   int64  `json:"bytes"`
}

func (s *syncStore) listSlots(w http.ResponseWriter, gid string) {
	dir := filepath.Join(s.groupDir(gid), "s")
	entries, _ := os.ReadDir(dir)
	rows := []slotRow{}
	for _, x := range entries {
		if !strings.HasSuffix(x.Name(), ".json") {
			continue
		}
		var env envelope
		if e := readSync(filepath.Join(dir, x.Name()), &env); e != nil {
			continue
		}
		info, _ := x.Info()
		var size int64
		if info != nil {
			size = info.Size()
		}
		rows = append(rows, slotRow{Slot: env.Slot, Counter: env.Counter, Recv: env.Recv, Bytes: size})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"slots": rows, "now": stamp()})
}

func (s *syncStore) slot(w http.ResponseWriter, r *http.Request, gid, fp string, raw []byte) {
	if !idRe.MatchString(fp) {
		fail(w, http.StatusNotFound, "no such slot")
		return
	}
	path := s.slotPath(gid, fp)
	switch r.Method {
	case http.MethodGet:
		b, e := os.ReadFile(path)
		if e != nil {
			fail(w, http.StatusNotFound, "nothing in that slot")
			return
		}
		sendBlob(w, b)
	case http.MethodDelete:
		if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
			fail(w, http.StatusInternalServerError, "could not remove it")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodPut:
		s.write(w, gid, fp, raw)
	default:
		fail(w, http.StatusMethodNotAllowed, "not a method for a slot")
	}
}

func (s *syncStore) write(w http.ResponseWriter, gid, fp string, raw []byte) {
	if !s.allow(gid + "/" + fp) {
		fail(w, http.StatusTooManyRequests, "writing faster than this endpoint accepts")
		return
	}
	var env envelope
	if e := json.Unmarshal(raw, &env); e != nil {
		fail(w, http.StatusBadRequest, "not an envelope")
		return
	}
	path := s.slotPath(gid, fp)
	var held envelope
	fresh := readSync(path, &held) != nil
	if fresh && countIn(filepath.Join(s.groupDir(gid), "s")) >= maxSlots {
		fail(w, http.StatusConflict, "this group already has as many devices as it takes")
		return
	}
	if e := checkEnvelope(&env, gid, fp, held.Counter); e != nil {
		fail(w, http.StatusBadRequest, e.Error())
		return
	}
	if !s.roomFor(int64(len(raw))) {
		fail(w, http.StatusInsufficientStorage, "this endpoint is full")
		return
	}
	env.Recv = stamp()
	if e := writeSync(path, env); e != nil {
		fail(w, http.StatusInternalServerError, "could not write it")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"slot": fp, "counter": env.Counter, "recv": env.Recv})
}

// ---- pairing --------------------------------------------------------------

/*
A pairing record is a five-minute conversation between two devices, held here

	because they have no other way to reach each other.

	The server can read what passes through it, which is why what passes through
	is a public key and a group key sealed to that public key -- and why both
	screens show six digits derived from both keys. An endpoint that substituted
	its own key would produce different digits, and the person comparing them is
	the check that no amount of server-side honesty could replace.
*/
func (s *syncStore) offerPair(w http.ResponseWriter, gid string, raw []byte) {
	var in struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	if e := json.Unmarshal(raw, &in); e != nil || !idRe.MatchString(in.ID) {
		fail(w, http.StatusBadRequest, "no usable pairing id")
		return
	}
	if key, e := b64.DecodeString(in.Key); e != nil || len(key) < 16 {
		fail(w, http.StatusBadRequest, "no usable pairing key")
		return
	}
	s.sweepPairs()
	if e := writeSync(s.pairPath(in.ID), pairRec{Group: gid, Key: in.Key, Created: stamp()}); e != nil {
		fail(w, http.StatusInternalServerError, "could not open the pairing")
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": in.ID, "expires": "5m"})
}

func (s *syncStore) servePair(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/pair/")
	if !idRe.MatchString(id) {
		fail(w, http.StatusNotFound, "no such pairing")
		return
	}
	raw, okay := body(w, r)
	if !okay {
		return
	}
	path := s.pairPath(id)
	var rec pairRec
	if e := readSync(path, &rec); e != nil {
		fail(w, http.StatusNotFound, "no such pairing")
		return
	}
	if info, e := os.Stat(path); e == nil && time.Since(info.ModTime()) > pairTTL {
		_ = os.Remove(path)
		fail(w, http.StatusGone, "that pairing has expired")
		return
	}
	key, e := b64.DecodeString(rec.Key)
	if e != nil {
		fail(w, http.StatusInternalServerError, "the pairing is unreadable")
		return
	}
	if !checkMAC(key, r.Header.Get("X-Hypnotica-Pair"), r.Method, r.URL.Path, raw) {
		fail(w, http.StatusForbidden, "not part of this pairing")
		return
	}
	if !s.allow("pair/" + id) {
		fail(w, http.StatusTooManyRequests, "too fast")
		return
	}
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"a": rec.A, "b": rec.B})
	case http.MethodPost, http.MethodPut:
		var in struct {
			A json.RawMessage `json:"a"`
			B json.RawMessage `json:"b"`
		}
		if e := json.Unmarshal(raw, &in); e != nil {
			fail(w, http.StatusBadRequest, "not JSON")
			return
		}
		if len(in.A) > 0 {
			rec.A = in.A
		}
		if len(in.B) > 0 {
			rec.B = in.B
		}
		if e := writeSync(path, rec); e != nil {
			fail(w, http.StatusInternalServerError, "could not write it")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		_ = os.Remove(path)
		w.WriteHeader(http.StatusNoContent)
	default:
		fail(w, http.StatusMethodNotAllowed, "not a method for a pairing")
	}
}

// ---- profiles ---------------------------------------------------------------

/*
A published document, readable by whoever holds the link and writable only by

	the group that published it. Its read key is derived from the share key the
	link carries, so a profile id on its own fetches nothing: handing somebody the
	URL and handing them the key are the same act, which is the point.
*/
func (s *syncStore) serveProfile(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/profile/")
	if !idRe.MatchString(id) {
		fail(w, http.StatusNotFound, "no such profile")
		return
	}
	raw, okay := body(w, r)
	if !okay {
		return
	}
	path := s.profilePath(id)
	var rec profileRec
	held := readSync(path, &rec) == nil

	if r.Method == http.MethodGet {
		if !held {
			fail(w, http.StatusNotFound, "no such profile")
			return
		}
		key, e := b64.DecodeString(rec.Read)
		if e != nil || !checkMAC(key, r.Header.Get("X-Hypnotica-Read"), r.Method, r.URL.Path, raw) {
			fail(w, http.StatusForbidden, "that link does not open this")
			return
		}
		if !s.allow("profile/" + id) {
			fail(w, http.StatusTooManyRequests, "too fast")
			return
		}
		sendBlob(w, rec.Env)
		return
	}

	// Writing needs the group, which the header names and the MAC proves.
	gid := r.Header.Get("X-Hypnotica-Group")
	if held && rec.Group != gid {
		fail(w, http.StatusForbidden, "another group published this")
		return
	}
	_, key, known := s.group(gid)
	if !known {
		fail(w, http.StatusNotFound, "no such group")
		return
	}
	if !checkMAC(key, r.Header.Get("X-Hypnotica-Auth"), r.Method, r.URL.Path, raw) {
		fail(w, http.StatusForbidden, "not a member of that group")
		return
	}

	switch r.Method {
	case http.MethodDelete:
		if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
			fail(w, http.StatusInternalServerError, "could not revoke it")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodPut:
		var in struct {
			Read string          `json:"read"`
			Env  json.RawMessage `json:"env"`
		}
		if e := json.Unmarshal(raw, &in); e != nil {
			fail(w, http.StatusBadRequest, "not JSON")
			return
		}
		if !held {
			if k, e := b64.DecodeString(in.Read); e != nil || len(k) < 16 {
				fail(w, http.StatusBadRequest, "no usable read key")
				return
			}
			if s.profilesOf(gid) >= maxProfiles {
				fail(w, http.StatusConflict, "this group has as many shares as it takes")
				return
			}
			rec.Read = in.Read
			rec.Group = gid
		}
		var env envelope
		if e := json.Unmarshal(in.Env, &env); e != nil {
			fail(w, http.StatusBadRequest, "not an envelope")
			return
		}
		var was envelope
		if held {
			_ = json.Unmarshal(rec.Env, &was)
		}
		if e := checkEnvelope(&env, id, env.Slot, was.Counter); e != nil {
			fail(w, http.StatusBadRequest, e.Error())
			return
		}
		if !s.allow("profile/" + id) {
			fail(w, http.StatusTooManyRequests, "too fast")
			return
		}
		if !s.roomFor(int64(len(raw))) {
			fail(w, http.StatusInsufficientStorage, "this endpoint is full")
			return
		}
		env.Recv = stamp()
		blob, _ := json.Marshal(env)
		rec.Env = blob
		if e := writeSync(path, rec); e != nil {
			fail(w, http.StatusInternalServerError, "could not publish it")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"profile": id, "recv": env.Recv})
	default:
		fail(w, http.StatusMethodNotAllowed, "not a method for a profile")
	}
}

func (s *syncStore) profilesOf(gid string) int {
	entries, e := os.ReadDir(filepath.Join(s.opt.Dir, "pf"))
	if e != nil {
		return 0
	}
	n := 0
	for _, x := range entries {
		var rec profileRec
		if readSync(filepath.Join(s.opt.Dir, "pf", x.Name()), &rec) == nil && rec.Group == gid {
			n++
		}
	}
	return n
}

// ---- routing and inspection ---------------------------------------------------

/*
The endpoint is matched before the file server, never after. Nothing under

	these three prefixes is a file, and a static handler that answered first would
	quietly serve the store.
*/
func syncRoutes(sync, files http.Handler) http.Handler {
	if sync == nil {
		return files
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/sync/") || strings.HasPrefix(p, "/pair/") ||
			strings.HasPrefix(p, "/profile/") {
			sync.ServeHTTP(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

/*
What is being kept, and a way to stop keeping it. The defence against a group

	growing is eviction, not detection, so seeing one has to be easy.
*/
func SyncInspect(dir, remove string, out io.Writer) error {
	if remove != "" {
		if !idRe.MatchString(remove) {
			return fmt.Errorf("%q is not a group or profile id", remove)
		}
		gone := false
		if e := os.RemoveAll(filepath.Join(dir, "g", remove)); e == nil {
			gone = true
		}
		if e := os.Remove(filepath.Join(dir, "pf", remove+".json")); e == nil {
			gone = true
		}
		if !gone {
			return fmt.Errorf("nothing here is called %s", remove)
		}
		fmt.Fprintf(out, "removed %s\n", remove)
		return nil
	}
	groups, e := os.ReadDir(filepath.Join(dir, "g"))
	if e != nil {
		fmt.Fprintf(out, "Nothing in %s yet.\n", dir)
		return nil
	}
	for _, g := range groups {
		slots, _ := os.ReadDir(filepath.Join(dir, "g", g.Name(), "s"))
		var size int64
		newest := ""
		for _, x := range slots {
			if info, e := x.Info(); e == nil {
				size += info.Size()
				if when := info.ModTime().UTC().Format(time.RFC3339); when > newest {
					newest = when
				}
			}
		}
		fmt.Fprintf(out, "%s  %d device(s)  %d KiB  last write %s\n",
			g.Name(), len(slots), size/1024, orNever(newest))
	}
	shares, _ := os.ReadDir(filepath.Join(dir, "pf"))
	for _, x := range shares {
		var rec profileRec
		if readSync(filepath.Join(dir, "pf", x.Name()), &rec) != nil {
			continue
		}
		fmt.Fprintf(out, "%s  share of %s\n", strings.TrimSuffix(x.Name(), ".json"), rec.Group)
	}
	return nil
}

func orNever(s string) string {
	if s == "" {
		return "never"
	}
	return s
}

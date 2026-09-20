// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A device, as the browser would present one: a P-256 key whose fingerprint is
// the only name the server ever knows it by.
type testDevice struct {
	priv *ecdsa.PrivateKey
	spki []byte
	fp   string
}

func newDevice(t *testing.T) *testDevice {
	t.Helper()
	priv, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	spki, e := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if e != nil {
		t.Fatal(e)
	}
	return &testDevice{priv: priv, spki: spki, fp: fingerprint(spki)}
}

func (d *testDevice) envelope(t *testing.T, scope string, counter int64, ct []byte) []byte {
	t.Helper()
	h := sha256.Sum256(signedOver(scope, d.fp, counter, ct))
	r, s, e := ecdsa.Sign(rand.Reader, d.priv, h[:])
	if e != nil {
		t.Fatal(e)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	env := envelope{V: 1, Slot: d.fp, Key: b64.EncodeToString(d.spki), Counter: counter,
		Written: stamp(), N: b64.EncodeToString(make([]byte, 12)),
		Ct: b64.EncodeToString(ct), Sig: b64.EncodeToString(sig)}
	out, e := json.Marshal(env)
	if e != nil {
		t.Fatal(e)
	}
	return out
}

type rig struct {
	h      http.Handler
	group  string
	enrol  []byte
	invite string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	h := SyncHandler(SyncOptions{Dir: t.TempDir(), Invite: "let-me-in"})
	if h == nil {
		t.Fatal("no handler")
	}
	enrol := make([]byte, 32)
	if _, e := rand.Read(enrol); e != nil {
		t.Fatal(e)
	}
	gid := strings.ToLower(b32.EncodeToString(sha256.New().Sum(nil)[:16]))
	return &rig{h: h, group: gid, enrol: enrol, invite: "let-me-in"}
}

// do sends a request the way the browser does: MAC over method, path and body.
func (r *rig) do(t *testing.T, method, path string, body []byte, head map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("X-Hypnotica-Auth", macOver(r.enrol, method, path, body))
	for k, v := range head {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	return w
}

func (r *rig) create(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"auth": b64.EncodeToString(r.enrol)})
	return r.do(t, "POST", "/sync/"+r.group, body, map[string]string{"X-Hypnotica-Invite": r.invite})
}

func TestSyncGroupCreationNeedsTheInvite(t *testing.T) {
	r := newRig(t)
	body, _ := json.Marshal(map[string]string{"auth": b64.EncodeToString(r.enrol)})
	if w := r.do(t, "POST", "/sync/"+r.group, body, map[string]string{"X-Hypnotica-Invite": "guess"}); w.Code != http.StatusForbidden {
		t.Fatalf("a wrong invite created a group: %d", w.Code)
	}
	if w := r.create(t); w.Code != http.StatusCreated {
		t.Fatalf("the right invite did not: %d %s", w.Code, w.Body)
	}
	if w := r.create(t); w.Code != http.StatusConflict {
		t.Fatalf("creating twice should conflict: %d", w.Code)
	}
}

func TestSyncClosedByDefault(t *testing.T) {
	h := SyncHandler(SyncOptions{Dir: t.TempDir()})
	req := httptest.NewRequest("POST", "/sync/aaaaaaaaaaaaaaaaaaaaaaaaaa", strings.NewReader(`{"auth":"x"}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("an endpoint with no invite took a new group: %d", w.Code)
	}
}

func TestSyncSlotRoundTrip(t *testing.T) {
	r := newRig(t)
	r.create(t)
	d := newDevice(t)
	path := "/sync/" + r.group + "/" + d.fp
	env := d.envelope(t, r.group, 1, []byte("ciphertext-one"))

	if w := r.do(t, "PUT", path, env, nil); w.Code != http.StatusOK {
		t.Fatalf("a good write was refused: %d %s", w.Code, w.Body)
	}
	w := r.do(t, "GET", path, nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("reading it back failed: %d", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("a blob was served as %q", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("a blob was sniffable")
	}
	var back envelope
	if e := json.Unmarshal(w.Body.Bytes(), &back); e != nil {
		t.Fatal(e)
	}
	if back.Ct != b64.EncodeToString([]byte("ciphertext-one")) {
		t.Fatal("the ciphertext did not come back")
	}
	if back.Recv == "" {
		t.Fatal("the server did not stamp when it arrived")
	}

	// A list is how another device learns there is anything to fetch.
	w = r.do(t, "GET", "/sync/"+r.group+"/", nil, nil)
	var listing struct{ Slots []slotRow }
	if e := json.Unmarshal(w.Body.Bytes(), &listing); e != nil {
		t.Fatal(e)
	}
	if len(listing.Slots) != 1 || listing.Slots[0].Slot != d.fp {
		t.Fatalf("the slot is not listed: %s", w.Body)
	}
}

func TestSyncRejectsWhatItShould(t *testing.T) {
	r := newRig(t)
	r.create(t)
	d, other := newDevice(t), newDevice(t)
	path := "/sync/" + r.group + "/" + d.fp

	// Somebody else's slot, signed with this key.
	wrong := "/sync/" + r.group + "/" + other.fp
	if w := r.do(t, "PUT", wrong, d.envelope(t, r.group, 1, []byte("x")), nil); w.Code != http.StatusBadRequest {
		t.Fatalf("a device wrote a slot it does not name: %d", w.Code)
	}

	// A signature over a different group.
	if w := r.do(t, "PUT", path, d.envelope(t, "aaaaaaaaaaaaaaaaaaaaaaaaaa", 1, []byte("x")), nil); w.Code != http.StatusBadRequest {
		t.Fatalf("a signature from another group was taken: %d", w.Code)
	}

	// A tampered ciphertext, with the signature left alone.
	env := d.envelope(t, r.group, 1, []byte("honest"))
	var e1 envelope
	_ = json.Unmarshal(env, &e1)
	e1.Ct = b64.EncodeToString([]byte("tampered"))
	bad, _ := json.Marshal(e1)
	if w := r.do(t, "PUT", path, bad, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("a rewritten ciphertext was taken: %d", w.Code)
	}

	// Replay: the same counter twice.
	if w := r.do(t, "PUT", path, env, nil); w.Code != http.StatusOK {
		t.Fatalf("the honest write failed: %d %s", w.Code, w.Body)
	}
	if w := r.do(t, "PUT", path, env, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("an old counter was accepted, so state can be rolled back: %d", w.Code)
	}
	if w := r.do(t, "PUT", path, d.envelope(t, r.group, 2, []byte("second")), nil); w.Code != http.StatusOK {
		t.Fatalf("a higher counter was refused: %d", w.Code)
	}

	// No membership MAC at all.
	req := httptest.NewRequest("GET", path, nil)
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("a stranger read a slot: %d", w.Code)
	}
}

func TestSyncPairingRoundTrip(t *testing.T) {
	r := newRig(t)
	r.create(t)
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	id := strings.ToLower(b32.EncodeToString(key[:16]))

	body, _ := json.Marshal(map[string]string{"id": id, "key": b64.EncodeToString(key)})
	if w := r.do(t, "POST", "/sync/"+r.group+"/pair", body, nil); w.Code != http.StatusCreated {
		t.Fatalf("could not offer a pairing: %d %s", w.Code, w.Body)
	}

	// The joining device knows only the pairing key, which is what the code carries.
	post := func(method string, payload []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/pair/"+id, bytes.NewReader(payload))
		req.Header.Set("X-Hypnotica-Pair", macOver(key, method, "/pair/"+id, payload))
		w := httptest.NewRecorder()
		r.h.ServeHTTP(w, req)
		return w
	}
	if w := post("POST", []byte(`{"b":{"pub":"joiner"}}`)); w.Code != http.StatusNoContent {
		t.Fatalf("the joining device could not answer: %d %s", w.Code, w.Body)
	}
	w := post("GET", nil)
	var got struct{ A, B json.RawMessage }
	if e := json.Unmarshal(w.Body.Bytes(), &got); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(got.B), "joiner") {
		t.Fatalf("the offer did not see the answer: %s", w.Body)
	}
	if w := post("DELETE", nil); w.Code != http.StatusNoContent {
		t.Fatalf("the pairing did not close: %d", w.Code)
	}
	if w := post("GET", nil); w.Code != http.StatusNotFound {
		t.Fatalf("a closed pairing is still readable: %d", w.Code)
	}

	// Without the pairing key, the id alone opens nothing.
	req := httptest.NewRequest("GET", "/pair/"+id, nil)
	w = httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code == http.StatusOK {
		t.Fatal("a pairing id on its own was enough")
	}
}

func TestSyncProfileNeedsItsKey(t *testing.T) {
	r := newRig(t)
	r.create(t)
	d := newDevice(t)
	read := make([]byte, 32)
	_, _ = rand.Read(read)
	pid := strings.ToLower(b32.EncodeToString(read[:16]))
	path := "/profile/" + pid

	env := d.envelope(t, pid, 1, []byte("published"))
	payload, _ := json.Marshal(map[string]any{"read": b64.EncodeToString(read), "env": json.RawMessage(env)})
	if w := r.do(t, "PUT", path, payload, map[string]string{"X-Hypnotica-Group": r.group}); w.Code != http.StatusOK {
		t.Fatalf("publishing failed: %d %s", w.Code, w.Body)
	}

	// A reader with the link's key gets it; the id alone gets nothing.
	req := httptest.NewRequest("GET", path, nil)
	req.Header.Set("X-Hypnotica-Read", macOver(read, "GET", path, nil))
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), b64.EncodeToString([]byte("published"))) {
		t.Fatalf("the holder of the link could not read it: %d %s", w.Code, w.Body)
	}
	req = httptest.NewRequest("GET", path, nil)
	w = httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("a profile id on its own was enough: %d", w.Code)
	}

	// A viewer cannot write, even holding the read key.
	req = httptest.NewRequest("PUT", path, bytes.NewReader(payload))
	req.Header.Set("X-Hypnotica-Read", macOver(read, "PUT", path, payload))
	w = httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code == http.StatusOK {
		t.Fatal("a read key was enough to republish")
	}

	if w := r.do(t, "DELETE", path, nil, map[string]string{"X-Hypnotica-Group": r.group}); w.Code != http.StatusNoContent {
		t.Fatalf("revoking failed: %d", w.Code)
	}
	req = httptest.NewRequest("GET", path, nil)
	req.Header.Set("X-Hypnotica-Read", macOver(read, "GET", path, nil))
	w = httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("a revoked link still opens: %d", w.Code)
	}
}

func TestSyncRoutesBeforeTheFileServer(t *testing.T) {
	files := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("static"))
	})
	h := syncRoutes(SyncHandler(SyncOptions{Dir: t.TempDir()}), files)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/sync/aaaaaaaaaaaaaaaaaaaaaaaaaa/", nil))
	if strings.Contains(w.Body.String(), "static") {
		t.Fatal("the file server answered for the sync store")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/index.html", nil))
	if !strings.Contains(w.Body.String(), "static") {
		t.Fatal("an ordinary file stopped being served")
	}
}

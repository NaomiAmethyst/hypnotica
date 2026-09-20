/* An independent QR reader, written to check the encoder rather than to be one.

   It shares no code with the encoder on purpose: it rebuilds the function-module
   map from the specification, reads the format information to learn the mask,
   walks the data in the zigzag order, de-interleaves the blocks, and checks that
   every Reed-Solomon syndrome is zero. A placement, masking or interleaving
   mistake fails the round trip; a wrong generator polynomial fails the syndromes,
   which is the same arithmetic a scanner does before it trusts a single byte. */

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// Level M, versions 1 to 10: [ecc per block, [[blocks, data codewords], ...]]
const BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]],
  4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]],
  7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
                7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const MASKS = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/* The modules, taken back out of the one path the encoder drew. */
export function gridFromSVG(svg) {
  const view = /viewBox="0 0 (\d+) \1"/.exec(svg);
  if (!view) throw new Error("no square viewBox");
  const span = Number(view[1]);
  const quiet = 4, size = span - quiet * 2;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const path = /<path d="([^"]*)"/.exec(svg);
  if (!path) throw new Error("no path");
  for (const m of path[1].matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    grid[Number(m[2]) - quiet][Number(m[1]) - quiet] = 1;
  }
  return { grid, size, version: (size - 17) / 4 };
}

function functionMap(size, version) {
  const fixed = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fixed[r][c] = 1; };
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) mark(r0 + i, c0 + j);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const r of ALIGN[version]) for (const c of ALIGN[version]) {
    if ((r < 8 && c < 8) || (r < 8 && c > size - 9) || (r > size - 9 && c < 8)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) mark(r + i, c + j);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      mark(size - 11 + j, i); mark(i, size - 11 + j);
    }
  }
  return fixed;
}

function readFormat(grid) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits[i] = grid[8][i];
  bits[6] = grid[8][7]; bits[7] = grid[8][8]; bits[8] = grid[7][8];
  for (let i = 9; i <= 14; i++) bits[i] = grid[14 - i][8];
  let value = 0;
  for (let i = 14; i >= 0; i--) value = (value << 1) | bits[i];
  const cleaned = value ^ 0x5412;
  // Fifteen bits, of which the top five are the level and the mask.
  return { level: (cleaned >> 13) & 3, mask: (cleaned >> 10) & 7, raw: cleaned };
}

function syndromesZero(block, ecc) {
  const all = [...block, ...ecc];
  for (let i = 0; i < ecc.length; i++) {
    let sum = 0;
    for (const byte of all) sum = mul(sum, EXP[i]) ^ byte;
    if (sum !== 0) return false;
  }
  return true;
}

/* Returns the text, or throws saying what did not line up. */
export function readQR(svg) {
  const { grid, size, version } = gridFromSVG(svg);
  if (!BLOCKS[version]) throw new Error(`version ${version} is out of range`);
  const fixed = functionMap(size, version);
  const { mask, level } = readFormat(grid);
  if (level !== 0) throw new Error(`format says error level ${level}, not M`);
  const unmasked = grid.map((row, i) =>
    Uint8Array.from(row, (v, j) => (fixed[i][j] ? v : v ^ (MASKS[mask](i, j) ? 1 : 0))));

  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!fixed[row][col]) bits.push(unmasked[row][col]);
      }
    }
    upward = !upward;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }

  const [eccPer, groups] = BLOCKS[version];
  const sizes = [];
  for (const [count, len] of groups) for (let i = 0; i < count; i++) sizes.push(len);
  const blocks = sizes.map(() => []);
  let at = 0;
  const widest = Math.max(...sizes);
  for (let i = 0; i < widest; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < sizes[b]) blocks[b].push(words[at++]);
  }
  const eccs = blocks.map(() => []);
  for (let i = 0; i < eccPer; i++) for (let b = 0; b < blocks.length; b++) eccs[b].push(words[at++]);
  for (let b = 0; b < blocks.length; b++) {
    if (!syndromesZero(blocks[b], eccs[b])) {
      throw new Error(`block ${b} does not check out: the error correction is wrong`);
    }
  }

  const data = blocks.flat();
  const stream = [];
  for (const w of data) for (let i = 7; i >= 0; i--) stream.push((w >> i) & 1);
  let p = 0;
  const take = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[p++]; return v; };
  const mode = take(4);
  if (mode !== 4) throw new Error(`mode ${mode} is not byte mode`);
  const length = take(version < 10 ? 8 : 16);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = take(8);
  return { text: new TextDecoder().decode(out), version, mask };
}

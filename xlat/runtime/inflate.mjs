// Raw DEFLATE (RFC 1951), decoded synchronously: a file of the root is read
// inside a system call, where nothing can wait for a stream. `size`, when
// known, is the decoded length, so the output is allocated once.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code as counts per length and symbols in order. */
function table(lengths) {
  const counts = new Uint16Array(16), symbols = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return {counts, symbols};
}

const FIXED_LIT = table(Array.from({length: 288}, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = table(new Array(30).fill(5));

export function inflateRaw(src, size = 0) {
  let out = new Uint8Array(size || Math.max(1024, src.length * 4)), at = 0;
  let pos = 0, bit = 0, bits = 0;
  const need = (n) => {
    if (at + n <= out.length) return;
    const grown = new Uint8Array(Math.max(at + n, out.length * 2));
    grown.set(out.subarray(0, at));
    out = grown;
  };
  const get = (n) => {
    while (bits < n) {
      if (pos >= src.length) throw new Error('inflate: input ends early');
      bit |= src[pos++] << bits;
      bits += 8;
    }
    const v = bit & ((1 << n) - 1);
    bit >>>= n;
    bits -= n;
    return v;
  };
  const decode = ({counts, symbols}) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= get(1);
      const count = counts[len];
      if (code - count < first) return symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let last = 0;
  while (!last) {
    last = get(1);
    const type = get(2);
    if (type === 0) {
      bit = 0; bits = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      need(len);
      out.set(src.subarray(pos, pos + len), at);
      pos += len; at += len;
      continue;
    }
    let lit = FIXED_LIT, dist = FIXED_DIST;
    if (type === 2) {
      const hlit = get(5) + 257, hdist = get(5) + 1, hclen = get(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cl[ORDER[i]] = get(3);
      const clt = table(cl);
      const lens = [];
      while (lens.length < hlit + hdist) {
        const s = decode(clt);
        if (s < 16) lens.push(s);
        else if (s === 16) { const p = lens[lens.length - 1]; for (let r = 3 + get(2); r > 0; r--) lens.push(p); }
        else if (s === 17) { for (let r = 3 + get(3); r > 0; r--) lens.push(0); }
        else { for (let r = 11 + get(7); r > 0; r--) lens.push(0); }
      }
      lit = table(lens.slice(0, hlit));
      dist = table(lens.slice(hlit));
    } else if (type !== 1) throw new Error('inflate: bad block');
    for (;;) {
      const s = decode(lit);
      if (s < 256) { need(1); out[at++] = s; continue; }
      if (s === 256) break;
      const li = s - 257;
      const len = LEN_BASE[li] + get(LEN_EXTRA[li]);
      const di = decode(dist);
      const d = DIST_BASE[di] + get(DIST_EXTRA[di]);
      need(len);
      for (let k = 0; k < len; k++, at++) out[at] = out[at - d];
    }
  }
  return at === out.length ? out : out.subarray(0, at);
}

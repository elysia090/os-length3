/* ---- Running it ---- */

/* Whether a character is a word's (\w): ASCII's by its bytes, Unicode's by U_WORD, read once into ranges. */
static u32 *wordr, nwordr;
static int char_word(u32 c) {
  if (c < 0x80) return c == '_' || (u32)((c | 0x20) - 'a') < 26u || (u32)(c - '0') < 10u;
  if (!wordr) {
    struct cls k;
    cls_init(&k);
    cls_table(&k, U_WORD, sizeof U_WORD);
    wordr = k.r, nwordr = k.n;
  }
  u32 lo = 0, hi = nwordr;
  while (lo < hi) {
    u32 mid = (lo + hi) / 2;
    if (c > wordr[2 * mid + 1]) lo = mid + 1;
    else hi = mid;
  }
  return lo < nwordr && c >= wordr[2 * lo];
}
/* The character at s[i] (decoded, or ~0 when the bytes there are not one), and its length (1 when not one). */
static u32 decode(const u8 *s, u64 n, u64 i, u32 *len) {
  u8 b = s[i];
  *len = 1;
  if (b < 0x80) return b;
  u32 k = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
  if (!k || b > 0xf4 || i + k > n) return ~0u;
  u32 c = b & (0x7f >> k);
  for (u32 j = 1; j < k; j++) {
    if ((s[i + j] & 0xc0) != 0x80) return ~0u;
    c = c << 6 | (s[i + j] & 0x3f);
  }
  if ((k == 2 && c < 0x80) || (k == 3 && (c < 0x800 || (c >= 0xd800 && c <= 0xdfff))) || (k == 4 && (c < 0x10000 || c > 0x10ffff))) return ~0u;
  *len = k;
  return c;
}
/* Whether a word's character begins at i / ends just before i, in s[0..n): 1, 0, or -1 when the bytes there are not a
 * character (as Rust's crate reads them: then neither \b nor \B holds there). */
static int word_at(const u8 *s, u64 n, u64 i) {
  if (i >= n) return 0;
  u32 len, c = decode(s, n, i, &len);
  return c == ~0u ? -1 : char_word(c);
}
static int word_before(const u8 *s, u64 n, u64 i) {
  if (!i) return 0;
  if (s[i - 1] < 0x80) return char_word(s[i - 1]);
  for (u64 j = i - 1, k = 0; k < 4; j--, k++) {
    if ((s[j] & 0xc0) != 0x80) {
      u32 len, c = decode(s, n, j, &len);
      return c != ~0u && j + len == i ? char_word(c) : -1;
    }
    if (!j) break;
  }
  return -1;
}
/* Whether assertion a holds at i in t[0..n). */
static int holds(u8 a, const u8 *t, u64 n, u64 i) {
  switch (a) {
    case A_BOT: return i == 0;
    case A_EOT: return i == n;
    case A_BOL: return i == 0 || t[i - 1] == '\n';
    case A_EOL: return i == n || t[i] == '\n';
    case A_WORD: return (word_before(t, n, i) == 1) != (word_at(t, n, i) == 1);
    default: {
      int b = word_before(t, n, i), w = word_at(t, n, i);
      return b >= 0 && w >= 0 && b == w;
    }
  }
}

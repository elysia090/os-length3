// What names bytes on the Remote: their SHA-256, as 64 hex digits. File contents are kept, asked for and checked by it
// (files.ts, trees.ts, mirror.ts), and so is whatever else is named by what it holds.

/** A digest as it is written: 64 lowercase hex digits. */
export const HEX = /^[0-9a-f]{64}$/;

/** The digest of `bytes`, as HEX writes it. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

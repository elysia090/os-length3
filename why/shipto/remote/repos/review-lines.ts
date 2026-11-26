import {sql, inArray, and, eq} from 'drizzle-orm';
import type {Basis, ReviewLine} from '../../../api/review-lines.ts';
import {blobKey, NO_FILES, type Bucket} from '../bytes/bucket.ts';
import {sha256} from '../bytes/digest.ts';
import {blob} from '../db/schema.ts';
import {refuse, rows, type Db} from '../serve/request.ts';

const TEXT_LIMIT = 1 << 20; // Same as the core's diff; binary or larger files have no lines to mark.
const CHECK_LIMIT = 8 << 20; // Match the Remote's existing blob-read batch budget.

/** Check that each selected side is real immutable text of a changed file in this repo. No user filenames touch disk. */
export async function verifyReviewLines(db: Db, bucket: Bucket | null, user: string, repo: number,
  basis: Basis, lines: readonly ReviewLine[]) {
  if (!lines.length) return;
  if (!bucket) refuse(503, NO_FILES);
  const paths = [...new Set(lines.map((l) => l.path))];
  const matched = await rows<{path: string; before: string | null; after: string | null}>(db, sql`
    select x.path, cut_path(${repo}, ${basis.base}, x.path) as before, cut_path(${repo}, ${basis.head}, x.path) as after
    from jsonb_array_elements_text(${JSON.stringify(paths)}::jsonb) as x(path)
  `);
  const each = new Map(matched.map((r) => [r.path,r]));
  const selection = new Map<string, number[]>();
  const nowhere = () => refuse(400, {error: 'A marked line is not present in this review'});
  for (const ref of lines) {
    const file = each.get(ref.path);
    if (!file || file.before === file.after) return nowhere();
    const sha = ref.side === 'old' ? file.before : file.after;
    if (!sha) return nowhere();
    const numbers = selection.get(sha);
    if (numbers) numbers.push(ref.line); else selection.set(sha, [ref.line]);
  }
  const sizes = await db.select({sha: blob.sha256, bytes: blob.bytes}).from(blob)
    .where(and(eq(blob.userId,user), inArray(blob.sha256,[...selection.keys()])));
  if (sizes.length !== selection.size) refuse(503, {error: 'The marked source could not be read'});
  if (sizes.some((r) => r.bytes > TEXT_LIMIT)) return nowhere();
  if (sizes.reduce((n,r) => n + r.bytes, 0) > CHECK_LIMIT) refuse(400, {error: 'Too much marked source to verify at once'});
  const decode = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  for (const row of sizes) {
    const bytes = await bucket.get(blobKey(user, row.sha));
    if (!bytes || bytes.length !== row.bytes || (await sha256(bytes)) !== row.sha) refuse(503, {error: 'The marked source could not be read'});
    let text: string;
    try { text = decode.decode(bytes); } catch { return nowhere(); }
    if (text.includes('\0')) return nowhere();
    const actual = text ? text.replace(/\n$/,'').split('\n') : [];
    if (selection.get(row.sha)!.some((n) => !actual[n-1]?.trim())) return nowhere();
  }
}

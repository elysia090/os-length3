// Move a complete distribution into place. The backup is outside the
// directory that the caller cleans, so a failed restore retains the old tree.
import {lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

function contains(parent: string, child: string) {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export function publishTree(staged: string, output: string, recoveryParent: string) {
  const stagePath = resolve(staged), destination = resolve(output);
  if (!lstatSync(stagePath).isDirectory()) throw new Error(`Not a staged distribution directory: ${stagePath}`);
  const next = realpathSync(stagePath), safe = realpathSync(recoveryParent);
  const overlappingTrees = () => new Error('Stage, recovery and published trees must not overlap');
  // Check before creating the destination's parent as well as after resolving
  // symlinks to it. Never create an output directory inside the staged tree.
  if (contains(next, destination)) throw overlappingTrees();
  // The parent may be missing. Find its nearest existing ancestor so this
  // check also works when a symlink leads to the staged tree.
  let ancestor = dirname(destination);
  while (!lstatSync(ancestor, {throwIfNoEntry: false})) ancestor = dirname(ancestor);
  const installed = resolve(realpathSync(ancestor), relative(ancestor, dirname(destination)), basename(destination));
  if (contains(next, installed) || contains(installed, next) || contains(installed, safe) || contains(next, safe)) {
    throw overlappingTrees();
  }
  const current = lstatSync(installed, {throwIfNoEntry: false});
  if (current && !current.isDirectory()) throw new Error(`Not a distribution directory: ${installed}`);
  mkdirSync(dirname(installed), {recursive: true});
  if (!current) { renameSync(next, installed); return; }

  const recovery = mkdtempSync(join(safe, '.ricebox-recovery-'));
  const previous = join(recovery, 'previous');
  let retain = false;
  try {
    renameSync(installed, previous);
    try { renameSync(next, installed); }
    catch (error) {
      try { renameSync(previous, installed); }
      catch (restore) {
        retain = true;
        throw new AggregateError([error, restore], `Could not replace or restore the distribution; its previous copy is at ${previous}`);
      }
      throw error;
    }
  } finally { if (!retain) rmSync(recovery, {recursive: true, force: true}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , staged, installed, recovery, ...extra] = process.argv;
  if (!staged || !installed || !recovery || extra.length) throw new Error('Usage: publish-tree.ts STAGED OUTPUT RECOVERY_PARENT');
  publishTree(staged, installed, recovery);
}

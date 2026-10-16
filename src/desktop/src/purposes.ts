// The leftmost rail chooses a purpose and the whole main area shows it;
// there is no intermediate pane. File is the one operation among them: it
// lays the tree of "/" over the page instead of replacing it. Purposes are not directories: the
// filesystem stays an ordinary POSIX tree and never re-implements this
// classification.

export type PurposeId =
  | 'home' | 'file' | 'git' | 'forge' | 'runtime' | 'remote' | 'topic' | 'inbox'
  | 'new-repo';

export interface Purpose {
  readonly id: PurposeId;
  readonly label: string;
  /** What the purpose is for, in one phrase. */
  readonly role: string;
  /** What the page will hold once the surface is real. */
  readonly detail: string;
  /** Whether the page shows real state yet. */
  readonly implemented: boolean;
}

export const PURPOSES: readonly Purpose[] = [
  {id: 'home', label: 'Home', role: 'プロフィール',
    detail: '自分にも他人にも同じ形で見えるページ。repoと投稿が並ぶ。', implemented: true},
  {id: 'forge', label: 'Forge', role: '自分の作業場',
    detail: '上の帯でrepoを選び、いまのfileをbrowserのようにスクロールして読む。右に参照とterminal。', implemented: true},
  {id: 'git', label: 'Git', role: 'repoの外部状態',
    detail: '誰がいつpushしたか、提出された変更の確認・Merge・Rejectがどうなっているか。', implemented: false},
  {id: 'file', label: 'File', role: '/ のtree',
    detail: 'システム全体の / を、今のページに重ねて開く。repoの中を選ぶとForgeでそこを開く。', implemented: true},
  {id: 'runtime', label: 'Runtime', role: '有効化された環境',
    detail: '実際に有効なbase・ツール版・Dotfilesの差分と、その適用元。', implemented: true},
  {id: 'remote', label: 'Remote', role: '同期',
    detail: '手元の作業を預け、別の場所でも扱う。SSHの有効化とは別の操作。', implemented: false},
  {id: 'topic', label: 'Topic', role: 'シンプルな投稿',
    detail: '最近の流行りなどを短く共有する。', implemented: false},
  {id: 'inbox', label: 'Inbox', role: '自分に届く型付きメッセージ',
    detail: 'レビュー依頼・変更提出・質問などを、対象と対応操作つきで受け取る。', implemented: false},
];

/** The round + under the rail's places: create a repo, not a purpose view. */
export const NEW_REPO: Purpose = {id: 'new-repo', label: '新しいrepo', role: 'repoの作成',
  detail: '標準的なrepoテンプレートを選び、独立したrepoとして作る。', implemented: true};

/** Rail order, top to bottom, as keyboard navigation walks it. */
export const RAIL: readonly Purpose[] = [...PURPOSES, NEW_REPO];

export const DEFAULT_PURPOSE: PurposeId = 'home';

export function purpose(id: PurposeId): Purpose {
  const found = RAIL.find((p) => p.id === id);
  if (!found) throw new Error(`unknown purpose ${id}`);
  return found;
}

/**
 * A stored value is a convenience only; anything unknown falls back to Home.
 * Creating a repo is a step, not a place to reopen the app into, and File
 * is an operation over a page.
 */
export function restorePurpose(stored: string | null | undefined): PurposeId {
  // File opens over a page and is never the page itself.
  return PURPOSES.some((p) => p.id === stored && p.id !== 'file') ? stored as PurposeId : DEFAULT_PURPOSE;
}

/**
 * Vertical rail keys, wrapping at both ends like a tab list. Returns null for
 * keys the rail does not handle so other shortcuts keep working.
 */
export function stepPurpose(current: PurposeId, key: string): PurposeId | null {
  const at = RAIL.findIndex((p) => p.id === current);
  const last = RAIL.length - 1;
  const next = key === 'ArrowDown' ? (at + 1) % RAIL.length
    : key === 'ArrowUp' ? (at + last) % RAIL.length
    : key === 'Home' ? 0
    : key === 'End' ? last
    : null;
  return next === null ? null : RAIL[next].id;
}

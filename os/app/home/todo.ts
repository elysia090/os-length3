// TODO lives on Home: one list for the person, not one file per repo.
// An item's first line is named the way issues are named in this OS, a kind
// and a title ("Fix：再起動すると保存内容が消える"); the lines after it are the
// detail. The list is kept in Home's state (state.ts), the same file l3 todo reads.

import {clipUnits, kindOf} from '../repos/text.ts';

export interface Todo {
  id: string;
  /** "Fix", "Patch", "RFC" or any short word; null for a plain line. */
  kind: string | null;
  title: string;
  /** The lines after the first. */
  detail: string;
  done: boolean;
  /** Repo the item is about, if any. */
  repo: string | null;
  created: number;
}

export const TEXT_LIMIT = 200;
export const DETAIL_LIMIT = 4000;


let counter = 0;
const newId = (now: number) => `${now.toString(36)}-${(counter++).toString(36)}`;

/** Add a line written as "Kind：title" or plain text. */
export function add(list: readonly Todo[], text: string, repo: string | null = null, now = Date.now()): Todo[] {
  const {kind, title} = kindOf(clipUnits(text, TEXT_LIMIT));
  if (!title.trim() && !kind) return [...list];
  return [...list, {id: newId(now), kind, title: title.trim(), detail: '', done: false, repo, created: now}];
}

/** Insert an empty item after `id` (or at the end); returns the list and the new id. */
export function insertAfter(list: readonly Todo[], id: string | null, now = Date.now()): {list: Todo[]; id: string} {
  const item: Todo = {id: newId(now), kind: null, title: '', detail: '', done: false, repo: null, created: now};
  const at = id === null ? list.length : list.findIndex((t) => t.id === id) + 1;
  const next = [...list];
  next.splice(at <= 0 ? list.length : at, 0, item);
  return {list: next, id: item.id};
}

export function edit(list: readonly Todo[], id: string, change: {kind?: string | null; title?: string; detail?: string}): Todo[] {
  return list.map((t) => (t.id === id ? {...t, ...change, title: clipUnits(change.title ?? t.title, TEXT_LIMIT),
    detail: clipUnits(change.detail ?? t.detail, DETAIL_LIMIT)} : t));
}

/** True when an item holds anything worth keeping. */
export const filled = (t: Todo) => t.title.trim() !== '' || t.kind !== null || t.detail.trim() !== '';

export function toggle(list: readonly Todo[], id: string): Todo[] {
  return list.map((t) => (t.id === id ? {...t, done: !t.done} : t));
}

export function remove(list: readonly Todo[], id: string): Todo[] {
  return list.filter((t) => t.id !== id);
}

/** What is kept: lines with content. Blank lines are editing state only. */
export function persisted(list: readonly Todo[]): Todo[] {
  return list.filter(filled).map((t) => ({...t, title: t.title.trim(), detail: t.detail.replace(/\s+$/, '')}));
}

export function parse(stored: string | null): Todo[] {
  try {
    const v = JSON.parse(stored ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t.id === 'string' && typeof t.done === 'boolean'
      && (t.repo === null || typeof t.repo === 'string') && typeof t.created === 'number'
      && (typeof t.title === 'string' || typeof t.text === 'string'))
      .map((t) => {
        // Earlier lists stored "Kind：title" as one string.
        const {kind, title} = typeof t.title === 'string'
          ? {kind: typeof t.kind === 'string' ? t.kind : null, title: t.title} : kindOf(t.text);
        const detail = typeof t.detail === 'string' ? clipUnits(t.detail, DETAIL_LIMIT) : '';
        return {id: t.id, kind, title: clipUnits(title, TEXT_LIMIT), detail, done: t.done, repo: t.repo, created: t.created};
      });
  } catch {
    return [];
  }
}

// TODO lives on Home: one list for the person, not one file per repo.
// Until accounts exist it is kept on this device.

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  /** Repo the item is about, if any. */
  repo: string | null;
  created: number;
}

export const TEXT_LIMIT = 200;

export function add(list: readonly Todo[], text: string, repo: string | null = null, now = Date.now()): Todo[] {
  const t = text.trim().slice(0, TEXT_LIMIT);
  if (!t) return [...list];
  return [...list, {id: `${now.toString(36)}-${list.length}`, text: t, done: false, repo, created: now}];
}

export function toggle(list: readonly Todo[], id: string): Todo[] {
  return list.map((t) => (t.id === id ? {...t, done: !t.done} : t));
}

export function remove(list: readonly Todo[], id: string): Todo[] {
  return list.filter((t) => t.id !== id);
}

/** Open items first in the order added, then finished ones. */
export function ordered(list: readonly Todo[]): Todo[] {
  return [...list.filter((t) => !t.done), ...list.filter((t) => t.done)];
}

export function parse(stored: string | null): Todo[] {
  try {
    const v = JSON.parse(stored ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t.id === 'string' && typeof t.text === 'string' && typeof t.done === 'boolean'
      && (t.repo === null || typeof t.repo === 'string') && typeof t.created === 'number')
      .map((t) => ({id: t.id, text: t.text.slice(0, TEXT_LIMIT), done: t.done, repo: t.repo, created: t.created}));
  } catch {
    return [];
  }
}

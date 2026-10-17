// The one way a first line is named in this OS (core/src/text.rs): a kind
// and a title, "Fix：再起動すると保存内容が消える". TODO items, issues and
// cuts all use it.

/** Split "Kind：title" (full- or half-width colon). */
export function kindOf(text: string): {kind: string | null; title: string} {
  const m = /^\s*([A-Za-z][A-Za-z0-9-]{0,15})\s*[：:]\s*(.*)$/s.exec(text);
  return m ? {kind: m[1], title: m[2]} : {kind: null, title: text.trim()};
}

/** The first line again: "Kind：title", or the title alone. */
export const named = (kind: string | null, title: string) => (kind ? `${kind}：${title.trim()}` : title.trim());

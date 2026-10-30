// The one way a first line is named in this OS (core/src/text.rs): a kind
// and a title, "Fix：再起動すると保存内容が消える". TODO items, issues and
// cuts all use it.

/**
 * A kind: a short word, Latin from a letter (Fix) or Japanese in kana and kanji alone (買う), as KANA_KANJI (i18n.ts)
 * and 々 count them.
 */
export const KIND_WORD = '[A-Za-z][A-Za-z0-9-]{0,15}|[\\u3005\\u3040-\\u30fa\\u30fc-\\u30ff\\u3400-\\u9fff]{1,16}';
const KIND = new RegExp(`^\\s*(${KIND_WORD})\\s*(?:：|:(?!\\/\\/))\\s*(.*)$`, 's');

/** Split "Kind：title" (full- or half-width colon). An address's scheme (https://) is no kind: the line is its title whole. */
export function kindOf(text: string): {kind: string | null; title: string} {
  const m = KIND.exec(text);
  return m ? {kind: m[1], title: m[2]} : {kind: null, title: text.trim()};
}

/**
 * At most `n` UTF-16 units of `text` (as a field's maxlength counts), never
 * half of a character: one cut in two would be a lone surrogate, which no
 * other reader of the JSON it is kept in (l3) takes.
 */
export function clipUnits(text: string, n: number): string {
  const cut = text.slice(0, n);
  return cut.length === n && /[\uD800-\uDBFF]$/.test(cut) && /^[\uDC00-\uDFFF]/.test(text.slice(n)) ? cut.slice(0, -1) : cut;
}

/** At most `n` characters of `text`, as l3 counts them (code points). */
export const clipChars = (text: string, n: number): string => (text.length <= n ? text : [...text].slice(0, n).join(''));

/** The first line again: "Kind：title", or the title alone. */
export const named = (kind: string | null, title: string) => (kind ? `${kind}：${title.trim()}` : title.trim());

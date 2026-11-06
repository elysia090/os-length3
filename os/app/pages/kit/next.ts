// Where a page opens next, said by the page that leads there before it goes (ctx.go): Inbox at a conversation
// (Home's Lately, Forge's and Git's people, a server's member). Taken once, as the page is drawn.

let inbox: string | null = null;
/** Inbox opens at the conversation with `address` next. */
export function openNext(address: string) { inbox = address; }
/** The conversation Inbox was asked to open at, once: asked again, none. */
export function takeNext(): string | null { const at = inbox; inbox = null; return at; }

import {h} from '../../ui/dom.ts';

// The pieces Runtime's parts share (this device, the Prompts running, SSH, the dotfiles).

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button small-button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/** A small card: what it is, quietly what it holds, and its action at the bottom right. */
export function card(name: string, lines: (string | Node)[], act: Node | null, extra = ''): HTMLElement {
  return h('div', {class: `card small-card ${extra}`.trim()},
    h('span', {class: 'card-title'}, name),
    ...lines.filter(Boolean).map((l) => (typeof l === 'string' ? h('span', {class: 'muted small'}, l) : l)),
    act ? h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), act) : null);
}

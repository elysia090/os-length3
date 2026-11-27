import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';

/** One topic in hand. Its two faces share the paper and neither moves the index. */
export class TopicDesk {
  readonly paper = h('section', {class: 'server-paper', 'aria-label': t('Topic')});
  readonly element = h('div', {class: 'server-topic'}, this.paper);
  k = 0;
  private count = 0;
  private drop: (() => void) | undefined;

  private readonly ways: {
    box(j: number): {body: HTMLElement; over?: HTMLElement; drop?: () => void};
    landed(j: number, pressed: boolean): void;
  };
  private readonly foot: HTMLElement;

  constructor(ways: TopicDesk['ways'], foot: HTMLElement) { this.ways = ways; this.foot = foot; }

  fill(count: number, at: number) {
    this.count = count;
    this.draw(at, false);
  }

  go(index: number, pressed = false) {
    if (index !== this.k && index >= 0 && index < this.count) this.draw(index, pressed);
  }

  private draw(index: number, pressed: boolean) {
    this.k = index;
    this.drop?.();
    const {body, over, drop} = this.ways.box(index);
    this.drop = drop;
    this.paper.replaceChildren(body, this.foot);
    this.paper.dataset.material = over ? 'topic' : 'plain';
    this.paper.setAttribute('aria-label', t('Topic'));
    this.element.replaceChildren(...(over ? [over] : []), this.paper);
    this.ways.landed(index, pressed);
  }

  stand(body: HTMLElement) {
    this.k = this.count = 0;
    this.drop?.(); this.drop = undefined;
    this.paper.dataset.material = 'plain';
    this.paper.replaceChildren(body, this.foot);
    this.element.replaceChildren(this.paper);
  }

  instead(node: Node) {
    this.stand(h('div', {class: 'board-card board-said'}, node));
  }
}

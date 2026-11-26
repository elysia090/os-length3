import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';
import type {Bench} from '../bench/bench.ts';
import {TERMINAL_SIDES, type TerminalSide} from '../bench/sessions.ts';
import {terminalMenu} from './document-menu.ts';

/** A right-bay companion that leaves the document desk, not a place with a title of its own. */
export class PromptPaper {
  readonly element: HTMLElement;
  readonly #previous = this.#button(t('Previous terminal'), 'previous');
  readonly #next = this.#button(t('Next terminal'), 'next');
  readonly #rail = TERMINAL_SIDES.map(side=>h('button',{class:'terminal-rail-place',type:'button',
    'aria-label':side==='left'?t('Left terminal'):t('Right terminal'),'aria-pressed':'false'}));
  readonly #work: Bench;
  readonly #room: HTMLElement;
  readonly #menu: ReturnType<typeof terminalMenu>;

  constructor(room:HTMLElement, work:Bench, hide:()=>void) {
    this.#work=work; this.#room=room;
    const head=h('header',{class:'terminal-paper-head'},this.#previous,
      h('h2',{class:'terminal-paper-name'},t('Prompt')),
      h('div',{class:'terminal-paper-rail',role:'group','aria-label':t('Terminal order')},...this.#rail),this.#next);
    this.element=h('div',{class:'desk-box forge-prompt-slot','data-kind':'term',hidden:''},head,work.terminal!);
    this.#menu=terminalMenu(this.element,()=>work.terminalInput(),hide);
    this.#previous.addEventListener('click',()=>this.#pick('left'));
    this.#next.addEventListener('click',()=>this.#pick('right'));
    this.#rail.forEach((place,i)=>place.addEventListener('click',()=>this.#pick(TERMINAL_SIDES[i]!)));
    this.element.addEventListener('keydown',e=>{
      if(e.key!=='Escape'||e.isComposing||e.defaultPrevented||this.element.querySelector('.desk-term:not([hidden]) [data-raw]'))return;
      e.preventDefault();e.stopPropagation();hide();
    });
    room.append(this.element);
    this.refresh();
  }

  #button(label:string, way:string):HTMLButtonElement {
    return h('button',{class:`terminal-turn ${way}`,type:'button','aria-label':label},h('span',{'aria-hidden':'true'})) as HTMLButtonElement;
  }
  #pick(side:TerminalSide) {
    if(this.element.hidden || this.#work.terminalSide===side)return;
    this.#menu.dismiss();this.#work.pickTerminal(side);this.refresh();this.#work.showPrompt();
  }
  refresh() {
    const side=this.#work.terminalSide;
    this.#previous.disabled=side==='left';this.#next.disabled=side==='right';
    this.#rail.forEach((place,i)=>place.setAttribute('aria-pressed',String(TERMINAL_SIDES[i]===side)));
    this.element.dataset.terminal=side;
  }
  show() {
    this.element.hidden=false;this.#room.dataset.promptOpen='';
    this.refresh();this.#work.restoreTerminal();
  }
  hide() {
    this.#menu.dismiss();this.#work.rememberTerminal();
    this.element.hidden=true;delete this.#room.dataset.promptOpen;
  }
  dismiss() { this.#menu.dismiss(); }
  drop() { this.#menu.drop(); }
}

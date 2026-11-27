import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';
import {fieldCarried} from '../../ui/caret.ts';
import {still} from '../../ui/glide.ts';
import {moveTime, SPRING} from '../../ui/law.ts';
import type {Bench} from '../bench/bench.ts';
import {TERMINAL_SIDES, type TerminalSide} from '../bench/sessions.ts';
import {terminalMenu} from './document-menu.ts';

/** The retained terminal window: its two sessions turn inside the same fixed aperture. */
export class PromptPaper {
  readonly element: HTMLElement;
  readonly #previous = this.#button(t('Previous terminal'), 'previous');
  readonly #next = this.#button(t('Next terminal'), 'next');
  readonly #rules = ['left','right'].map(()=>h('span',{class:'terminal-paper-rule','aria-hidden':'true'}));
  readonly #marks = TERMINAL_SIDES.map(side=>h('button',{type:'button',class:'row-piece',
    'aria-label':side==='left'?t('Left terminal'):t('Right terminal'),'aria-current':'false'}));
  readonly #work: Bench;
  readonly #room: HTMLElement;
  readonly #menu: ReturnType<typeof terminalMenu>;
  readonly #wide: () => boolean;
  readonly #deck: HTMLElement;
  #turn: {from: HTMLElement; animations: Animation[]; frame: number} | null = null;

  constructor(room: HTMLElement, work: Bench, hide: () => void, wide: () => boolean) {
    this.#work = work; this.#room = room; this.#deck = work.terminal!; this.#wide = wide;
    // The same controls stand at the bottom of the wide shell and keep their old compact position on a phone.
    const map = h('div', {class:'terminal-session-switch', role:'group', 'aria-label':t('Terminal order')}, ...this.#marks);
    const head = h('header', {class:'terminal-paper-head'}, this.#previous, this.#rules[0]!,
      h('h2', {class:'terminal-paper-name'}, t('Prompt')), this.#rules[1]!, map, this.#next);
    head.addEventListener('pointerdown', e => {
      if (this.#wide() && e.button === 0 && !(e.target as Element | null)?.closest('button')) e.preventDefault();
    });
    this.element = h('div', {class:'desk-box forge-prompt-slot', 'data-kind':'term', id:'forge-prompt-paper', hidden:''}, head, this.#deck);
    this.#menu=terminalMenu(this.element,()=>work.terminalInput(),hide);
    this.#previous.addEventListener('click',()=>this.#pick('left'));
    this.#next.addEventListener('click',()=>this.#pick('right'));
    this.#marks.forEach((mark,i)=>mark.addEventListener('click',()=>{
      const side=TERMINAL_SIDES[i]!;
      if (this.#work.terminalSide===side) this.#work.showPrompt();
      else this.#pick(side);
    }));
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
  #pane(side: TerminalSide) {
    return this.#deck.querySelector<HTMLElement>(`:scope > .desk-term[data-terminal-side="${side}"]`);
  }

  #stopTurn() {
    const turn=this.#turn;
    if (!turn) return;
    this.#turn=null;
    cancelAnimationFrame(turn.frame);
    turn.animations.forEach(a=>a.cancel());
    delete turn.from.dataset.terminalLeaving;
    turn.from.inert=false;
    delete this.#deck.dataset.terminalMoving;
    fieldCarried();
  }

  #travel(from: HTMLElement, to: HTMLElement, start: number, enter: number, direction: number, width: number) {
    // Only the two real shells move. Their window (including its title and keys) stays outside the clipped deck.
    const at=(x:number)=>({translate:`${x}% 0px`});
    const time={duration:moveTime(Math.abs(enter)*width/100,width),easing:SPRING,fill:'both'} as const;
    const animations=[from.animate([at(start),at(-100*direction)],time),to.animate([at(enter),at(0)],time)];
    const turn=this.#turn={from,animations,frame:0};
    const carry=()=>{
      if(this.#turn!==turn)return;
      fieldCarried();
      turn.frame=requestAnimationFrame(carry);
    };
    carry();
    void animations[1]!.finished.then(()=>{ if(this.#turn===turn)this.#stopTurn(); },()=>{});
  }

  #pick(side:TerminalSide) {
    const before=this.#work.terminalSide;
    if(this.element.hidden || this.element.inert || before===side)return;
    this.#menu.dismiss();
    const from=this.#pane(before), previousTarget=this.#pane(side);
    const {left,width}=this.#deck.getBoundingClientRect(), direction=side==='right'?1:-1;
    const travel=!!from&&width>0&&this.#wide()&&!still();
    // Reverse from the positions on screen, not from an endpoint never reached.
    const start=travel&&this.#turn?(from.getBoundingClientRect().left-left)/width*100:0;
    const enter=travel&&this.#turn&&previousTarget
      ?(previousTarget.getBoundingClientRect().left-left)/width*100:direction*100;
    this.#stopTurn();
    if (travel) {
      this.#deck.dataset.terminalMoving='';
      // Bench still owns the chosen shell, including the outgoing shell's actual hidden state and remembered scroll.
      from.dataset.terminalLeaving='';
      from.inert=true;
    }
    this.#work.pickTerminal(side);
    const to=this.#pane(side);
    if (travel) {
      if (to && this.#work.terminalSide===side) this.#travel(from,to,start,enter,direction,width);
      else { delete from.dataset.terminalLeaving; from.inert=false; delete this.#deck.dataset.terminalMoving; }
    }
    this.refresh();
    this.#work.showPrompt();
  }
  refresh() {
    const side=this.#work.terminalSide;
    this.#previous.disabled=side==='left';this.#next.disabled=side==='right';
    this.#marks.forEach((mark,i)=>mark.setAttribute('aria-current',String(TERMINAL_SIDES[i]===side)));
    this.element.dataset.terminal=side;
  }
  show() {
    this.element.inert=false;this.element.hidden=false;this.#room.dataset.promptOpen='';
    this.refresh();this.#work.restoreTerminal();
  }
  hide(leaving = false) {
    this.#stopTurn();this.#menu.dismiss();this.#work.rememberTerminal();
    this.element.inert=true;this.element.hidden=!leaving;delete this.#room.dataset.promptOpen;
  }
  dismiss() { this.#stopTurn();this.#menu.dismiss(); }
  resized() { this.#stopTurn(); }
  drop() { this.#stopTurn();this.#menu.drop(); }
}

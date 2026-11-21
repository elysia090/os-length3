// The keeper owns the guest. A popup hosts the same view nodes, never another guest.
export function bindGuestViewWindow({view, slot, openButton, endButton, status, stopDrawing, endSession, canAct, budgetMs}: {
  view: HTMLElement, slot: HTMLElement, openButton: HTMLButtonElement, endButton: HTMLButtonElement,
  status: HTMLElement, stopDrawing: () => void, endSession: () => void, canAct: () => boolean, budgetMs: number,
}): () => void {
  type AttachedView = {win: Window, doc: Document, detached: () => void};
  let current: AttachedView | undefined, opened = false, ended = false;
  const owns = ({win, doc}: AttachedView) => {
    try { return !win.closed && win.document === doc && doc.URL === 'about:blank' && doc.defaultView === win; }
    catch { return false; }
  };
  function detach(expected: AttachedView, close: boolean) {
    if (current !== expected) return;
    current = undefined;
    try { expected.win.removeEventListener('pagehide', expected.detached); } catch {}
    try { stopDrawing(); } finally { slot.append(view); } // Adoption preserves the keeper's same terminal and event handlers.
    if (close && owns(expected)) expected.win.close();
    openButton.disabled = ended;
    openButton.textContent = 'Reopen guest view window';
    status.textContent = ended ? 'Guest session ended.' : 'View closed. The guest shell stays in this keeper.';
  }
  function end() {
    if (ended) return;
    ended = true;
    if (current) detach(current, true);
    window.clearInterval(check);
    window.clearTimeout(expiry);
    window.removeEventListener('pagehide', end);
    openButton.disabled = endButton.disabled = true;
    status.textContent = 'Guest session ended.';
    endSession();
  }
  const check=window.setInterval(() => { if (!canAct()) return; if (current && !owns(current)) detach(current, false); }, 250);
  const expiry=window.setTimeout(end, budgetMs);
  window.addEventListener('pagehide', end, {once:true});
  endButton.onclick = event => { if (event.isTrusted) end(); };
  openButton.onclick = event => {
    if (!event.isTrusted || ended || !canAct() || current || view.parentElement !== slot) return;
    const win = window.open('', '_blank', 'popup,width=728,height=688');
    if (!win) {
      status.textContent = 'The browser blocked the popup. Keep using this view, or allow popups and try again.';
      return;
    }
    let moved: AttachedView | undefined;
    try {
      const doc=win.document;
      const item: AttachedView={win, doc, detached:() => detach(item, false)};
      if (!owns(item) || win.opener !== window) throw new Error('Unexpected popup');
      win.opener = null; // This window needs no active opener and cannot reverse-navigate it.
      if (win.opener !== null) throw new Error('Unexpected popup opener');
      const css = document.querySelector('#guest-demo-styles');
      if (!(css instanceof HTMLStyleElement) || !doc.body || !doc.head) throw new Error('Missing guest view layout');
      const style=doc.createElement('style'), link=doc.createElement('link');
      style.textContent=css.textContent;
      link.rel='stylesheet';link.href=new URL('/camera-scrollbars.css',document.baseURI).href;
      const title=doc.createElement('h1');
      title.textContent='Ricebox guest view';
      const closeButton=doc.createElement('button');
      closeButton.type='button';closeButton.textContent='Close guest view window';
      closeButton.onclick=e=>{if(e.isTrusted)detach(item,true);};
      doc.title='Ricebox guest view';
      doc.head.append(style,link);
      doc.body.append(title,closeButton,view);
      current=moved=item; opened=true;
      win.addEventListener('pagehide', item.detached, {once:true});
      openButton.disabled=true;
      status.textContent='Guest view is open. Keep this tab open to reopen the same shell.';
    } catch {
      if (moved) detach(moved,true);
      else {
        if (view.parentElement!==slot) slot.append(view);
        try{if (win.document.URL === 'about:blank') win.close();}catch{}
      }
      status.textContent=opened ? 'Could not reopen the guest view. Try again from this keeper.' :
        'Could not open the guest view. Keep using this view, or try again.';
    }
  };
  return end;
}

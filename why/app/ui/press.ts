/** Activate on an unmodified mouse press for immediate feedback, then consume only that pointer's click.
 * Touch and keyboard keep native click activation. A cancelled press must never swallow the next activation. */
export function activateOnPress(button: HTMLElement, activate: () => void): void {
  let downed: number | null = null;
  button.addEventListener('pointerdown', (event) => {
    downed = null;
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    downed = event.pointerId;
    activate();
  });
  button.addEventListener('pointercancel', () => { downed = null; });
  button.addEventListener('click', (event) => {
    // Keyboard and programmatic clicks have detail=0. Older browsers expose MouseEvent rather than PointerEvent.
    const samePointer = !('pointerId' in event) || event.pointerId === downed;
    const already = downed !== null && event.detail > 0 && samePointer;
    downed = null;
    if (!already) activate();
  });
}

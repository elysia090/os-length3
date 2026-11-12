/** Option and the arrows belong to text navigation on Apple keyboards, including selection with Shift.
 * Ctrl+Alt remains an application chord. Keep the browser's default, even when the event bubbles to the desk. */
export function nativeOptionArrow(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /^(Mac|iPhone|iPad|iPod)/.test(platform) && event.altKey && !event.ctrlKey && !event.metaKey
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
}

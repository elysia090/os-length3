// Where a face's capitals stand in its line, as this computer sets it (styles.css, the box's line): a face keeps more
// room over its capitals than under its baseline, or less, by its own measure and by how each size is rounded here, so
// words set on a middle by their line stand a pixel or two off it. Where words can be trimmed to their capitals the
// styles do that (text-box); the box's line cannot (what is written in it is a field's), so its words are brought down
// by a length measured once in the face as it is here, the same for the pill's words and what is written beside them.

/** How far down (px) the capitals of a line set in `font` stand from the line's middle; 0 where it cannot be said. */
export function capDrop(font: string): number {
  const line = document.createElement('div'), base = document.createElement('span'), cap = document.createElement('span');
  line.style.cssText = `position: fixed; left: -999px; top: 0; visibility: hidden; white-space: pre; font: ${font}`;
  base.style.cssText = 'display: inline-block; width: 0; height: 0';
  cap.style.cssText = 'display: inline-block; width: 0; height: 1cap';
  line.append('H', base, cap);
  document.body.append(line);
  const box = line.getBoundingClientRect(), at = base.getBoundingClientRect().bottom, c = cap.getBoundingClientRect().height;
  line.remove();
  return c > 0 ? box.top + box.height / 2 - (at - c / 2) : 0;
}

/** The box's line's drop, kept on the page as --box-drop, again once the faces are all there. */
export function optical() {
  const keep = () => document.documentElement.style.setProperty('--box-drop', `${capDrop('var(--t-meta)/1.6 var(--mono)').toFixed(2)}px`);
  keep();
  void document.fonts?.ready.then(keep);
}

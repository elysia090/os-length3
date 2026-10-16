import type {PurposeId} from './purposes.ts';

// 24px line icons drawn with currentColor so selection is carried by the rail's
// own text color and indicator bar, never by the icon alone.
const PATHS: Record<PurposeId, string> = {
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  git: 'M7 7v10M17 10c0 4-10 3-10 7M7 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7 17.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM17 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  forge: 'M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h4',
  runtime: 'M12 4 3 9l9 5 9-5zM3 14l9 5 9-5',
  remote: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 11.5 3.25 3.25 0 0 0 7 18z',
  topic: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  inbox: 'M4 13 7 5h10l3 8v6H4zM4 13h5l1 2h4l1-2h5',
  'new-repo': 'M12 5v14M5 12h14',
};

export function icon(id: PurposeId): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[id]);
  svg.append(path);
  return svg;
}

const MARKS = {
  plus: 'M12 5v14M5 12h14',
  close: 'M7 7l10 10M17 7L7 17',
  // A cog: eight teeth round a ring, the hole in its middle.
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
} as const;

/** A small mark drawn like the icons: + to add, × to take off, the gear for settings. */
export function mark(name: keyof typeof MARKS): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon', 'mark');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', MARKS[name]);
  svg.append(path);
  return svg;
}

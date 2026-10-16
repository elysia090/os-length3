import type {PurposeId} from './purposes.ts';

// 24px line icons drawn with currentColor so selection is carried by the rail's
// own text color and indicator bar, never by the icon alone.
const PATHS: Record<PurposeId, string> = {
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  git: 'M7 7v10M17 10c0 4-10 3-10 7M7 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7 17.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM17 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  forge: 'M3 9h18M5 9l1.5 11h11L19 9M9 9V5h6v4M10 14h4',
  runtime: 'M12 4 3 9l9 5 9-5zM3 14l9 5 9-5',
  remote: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 11.5 3.25 3.25 0 0 0 7 18z',
  topic: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  inbox: 'M4 13 7 5h10l3 8v6H4zM4 13h5l1 2h4l1-2h5',
  'new-repo': 'M4 4h16v16H4zM12 8v8M8 12h8',
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

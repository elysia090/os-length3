import {moveTime, SPRING} from '../../ui/law.ts';
import {SHADOW} from './desk-layout.ts';

/** The retained document desk and the retained Prompt take turns through the same fixed paper aperture. */
export function turnPromptBay(desk: HTMLElement, prompt: HTMLElement, toPrompt: boolean,
  prior: [number, number] | undefined, landed: () => void): () => void {
  const aperture = desk.getBoundingClientRect();
  const window = prompt.getBoundingClientRect();
  const distance = Math.max(0, aperture.width - SHADOW);
  const from = [prior ? prior[0] - aperture.left : toPrompt ? 0 : -distance,
    prior ? prior[1] - window.left : toPrompt ? distance : 0];
  const to = toPrompt ? [-distance, 0] : [0, distance];
  const way = Math.max(...to.map((x, i) => Math.abs(x - from[i]!)));
  const time = {duration: moveTime(way, aperture.width), easing: SPRING, fill: 'both'} as const;
  const pose = (x: number) => ({translate: x + 'px 0px'});
  const slides = [desk, prompt].map((part, i) =>
    part.animate([pose(from[i]!), pose(to[i]!)], time));
  void slides[0]!.finished.then(landed, () => {});
  return () => slides.forEach(slide => slide.cancel());
}

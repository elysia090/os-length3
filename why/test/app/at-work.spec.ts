import {expect, test} from './fixtures.ts';
import {across, emptiness, emptyIn} from './weigh.ts';

// Forge at work (DESIGN §2, a shot computed; §10, Forge): the work itself never breaks the shot. Measured frame by
// frame while a file is written, gone through, pressed, left for the next by a key, and while the terminal runs:
//
//   eye-trace     the piece in hand is at the desk's edge, where the eye is after a move, unless it was pressed:
//                 then it is where it was pressed, under the hand
//   look room     the line written never stands in the third of the world it goes towards; a file whose lines pass
//                 the lower third stands to the foot, paper ahead of its last line; the terminal's last line, where its
//                 work is, out of the lower third
//   no jump       from one rest to the next a thing stands where it stood or has gone at least a cell
//   order kept    what is left of what is not reversed
//   weight        the weight of what is drawn lies left of the world's middle, the room ahead to the right, and the
//                 lower right of the world at least as empty as its upper left

const U = 24, F = 2 * U;
type Box = [number, number, number, number];
type Rest = {pieces: Record<string, Box>; held: string; caret: {top: number; foot: number; ahead: number; letter: number} | null; lower: number; upper: number; H: number};

/** What stands where now: the pieces in sight, the one in hand, the line the caret is on (in the window). */
function rest(): Rest {
  const H = innerHeight, r4 = (r: DOMRect): Box => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const pieces: Record<string, Box> = {};
  let held = '';
  for (const b of document.querySelectorAll<HTMLElement>('section.desk:not([hidden]) .desk-box')) {
    const r = b.getBoundingClientRect();
    if (r.right <= 48 || r.left >= innerWidth) continue;
    pieces[b.dataset.key!] = r4(r);
    if (b.classList.contains('held')) held = b.dataset.key!;
  }
  const a = document.activeElement as HTMLTextAreaElement | null;
  let caret: Rest['caret'] = null;
  if (a?.tagName === 'TEXTAREA' && a.closest('.desk-file')) {
    const at = a.selectionDirection === 'backward' ? a.selectionStart : a.selectionEnd;
    const line = a.value.slice(0, at).split('\n').length - 1, lh = parseFloat(getComputedStyle(a).lineHeight);
    const top = a.getBoundingClientRect().top + line * lh;
    // How much of the line is in sight ahead of the caret, in px, and a letter's width.
    const g = document.createElement('canvas').getContext('2d')!;
    g.font = getComputedStyle(a).font;
    const letter = g.measureText('0').width, col = at - (a.value.lastIndexOf('\n', at - 1) + 1);
    caret = {top, foot: top + lh, ahead: a.clientWidth - (col * letter - a.scrollLeft), letter};
  }
  return {pieces, held, caret, H, lower: 48 + 2 * (H - 48) / 3, upper: 48 + (H - 48) / 3};
}

for (const size of [{width: 1536, height: 864}, {width: 1024, height: 768}]) {
  test(`Forge at work at ${size.width}×${size.height}: the piece in hand at the edge or under the hand, the line written out of the third it goes towards, nothing jumping, nothing reversed, the weight to the left`, async ({signedIn: app}) => {
    test.setTimeout(600_000);
    const page = app.page;
    await page.setViewportSize(size);
    await app.newRepo.make('hello', {template: 'C'});
    await app.rail.go('forge');
    await expect(app.forge.editor('README.md')).toBeVisible();
    const now = () => page.evaluate(rest);
    let was: Rest | null = null;
    /** A rest measured, held against the one before it: nothing jumps, nothing is reversed. */
    const at = async (step: string) => {
      await page.waitForTimeout(450);
      const r = await now();
      if (was) {
        for (const [key, box] of Object.entries(r.pieces)) {
          const old = was.pieces[key];
          if (!old) continue;
          box.forEach((v, i) => {
            const by = Math.abs(v - old[i]!);
            expect(by === 0 || by >= U, `${step}: ${key} moved ${by} px (${['x', 'y', 'w', 'h'][i]}): a jump`).toBe(true);
          });
        }
        const order = (p: Rest) => Object.keys(p.pieces).filter((k) => was!.pieces[k] && r.pieces[k]).sort((a, b) => p.pieces[a]![0] - p.pieces[b]![0]);
        expect(order(r), `${step}: the row's order`).toEqual(order(was));
      }
      was = r;
      return r;
    };
    // Eye-trace: come to from the rail, the piece in hand at the desk's edge.
    let r = await at('arrive');
    expect(r.pieces[r.held]?.[0], `arrived: ${r.held} at the desk's edge`).toBe(F);
    expect(await across(page), 'arrived: the weight left of the middle').toBeLessThan(0);
    // Gone to by the keyboard (not pressed): it comes to the edge.
    await app.forge.editor('README.md').focus();
    r = await at('README taken by the keyboard');
    expect(r.held).toBe('README.md');
    expect(r.pieces['README.md']!.slice(0, 2), 'README at the edge, on the horizon').toEqual([F, 3 * U]);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Plan the trip.');
    const lines = Math.ceil(size.height / U) + 6;
    for (let i = 1; i <= lines; i++) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`A line written, number ${i}.`);
      if (i % 4 && i !== lines) continue;
      r = await at(`line ${i} written`);
      // Writing moves nothing but the line written: the piece where it stood, growing by whole lines from its top.
      expect(r.pieces['README.md']!.slice(0, 2), `line ${i}: README where it stood`).toEqual([F, 3 * U]);
      expect(r.pieces['README.md']![3] % U, `line ${i}: README whole lines tall`).toBe(0);
      // Look room: the line written never in the lower third.
      expect(r.caret!.foot, `line ${i}: the line written out of the lower third`).toBeLessThanOrEqual(r.lower + .5);
    }
    // A line run past the sheet's edge: fifteen letters of it ahead of the caret.
    await page.keyboard.press('Enter');
    await page.keyboard.type('A line that runs on past the edge of the sheet, written on and on to the eightieth letter.');
    // Gone along it by the keys from its start: the next fifteen letters of it in sight ahead of the caret.
    await page.keyboard.press('Home');
    for (let i = 0; i < 55; i++) await page.keyboard.press('ArrowRight');
    r = await at('along a long line');
    expect(r.caret!.ahead / r.caret!.letter, 'along a long line: its next fifteen letters in sight').toBeGreaterThanOrEqual(15 - .1);
    await page.keyboard.press('End');
    // Longer than the lower third: it stands to the foot (a cell over the window's), the last line at the third.
    expect(r.pieces['README.md']![1] + r.pieces['README.md']![3], 'a long file stands to the foot').toBe(size.height - U);
    expect(r.lower - r.caret!.foot, 'the last line written at the lower third').toBeLessThan(U);
    expect(await across(page), 'written: the weight left of the middle').toBeLessThan(0);
    const lean = async (when: string) => {
      const rows = await emptiness(page), R = rows.length, C = rows[0]!.length;
      expect(emptyIn(rows, R >> 1, R, C >> 1, C), `${when}: the lower right at least as empty as the upper left`).toBeGreaterThanOrEqual(emptyIn(rows, 0, R >> 1, 0, C >> 1));
    };
    await lean('written');
    // Gone back through it by the keys: its top under the upper third while there is more above.
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
    r = await at('gone back up');
    expect(r.caret!.top, 'going back: the line out of the upper third').toBeGreaterThanOrEqual(r.upper - .5);
    await page.keyboard.press('Control+Home');
    r = await at('to the top');
    expect(r.caret!.top, 'at the top: its first line').toBe(3 * U + U / 2);
    // The next piece pressed where it lies: it stays under the hand. (Only where it is whole in sight beside README.)
    const next = Object.entries(r.pieces).find(([k, b]) => k !== 'README.md' && b[0] > F && b[0] + b[2] + U / 2 <= size.width);
    if (next) {
      const [key, box] = next;
      await page.mouse.click(box[0] + 200, box[1] + 40);
      r = await at(`${key} pressed`);
      expect(r.held).toBe(key);
      expect(r.pieces[key]![0], `${key} pressed: under the hand`).toBe(box[0]);
    }
    // Left for the next by a key: it comes to the edge, where the eye was.
    await page.keyboard.press('Escape');
    const before = r.held;
    await page.keyboard.press('ArrowRight');
    r = await at('the next by a key');
    expect(r.held, 'the next by a key').not.toBe(before);
    expect(r.pieces[r.held]?.[0], `${r.held} by a key: at the desk's edge`).toBe(F);
    // The terminal running: at the edge, its last line (where its work is) out of the lower third.
    await app.forge.startPrompt('hello');
    await app.forge.run('seq 1 60');
    await expect(app.forge.prompt).toContainText('60');
    r = await at('the terminal ran');
    expect(r.held).toBe('term');
    const term = r.pieces.term!;
    expect(term[0], 'the terminal at the edge').toBe(F);
    expect(term[1] + term[3] - U, 'the terminal\'s last line out of the lower third').toBeLessThanOrEqual(r.lower + .5);
    expect(await across(page), 'running: the weight left of the middle').toBeLessThan(0);
    await lean('running');
  });
}

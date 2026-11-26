import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';
import {across, emptiness, emptyIn, fields} from './weigh.ts';

// Every rest a shot (DESIGN §2, the window is a camera): in every place, at four widths down to a phone, each frame is
// held to what film knows of a frame. Measured, not looked at:
//
//   one lens        nothing in sight is drawn scaled, zoomed or in perspective
//   one horizon     the subject's edges on the grid
//   one subject     one shadow cast in focus: 12 px right/down on sheets, 4 px on Forge's paper
//   the frame       under what is called up, the available frame controls stay in focus
//   eye-trace       what stands just past the frame's corner is what the place is, within 5° of where the hand was
//                   (the place's square on the rail, or the door): found without a search
//   look room       on a desk screen, the room ahead of the subject (to its right, the way the row runs) at least the
//                   room behind it, wherever it stands
//   weight          on a desk screen, the weight of what is drawn lies left of the world's middle (the room ahead to
//                   the right): never set in the middle, never leaning the way the row runs
//   the lean        the empty part of the world lies to its lower right, the frame's open sides: that quarter at least
//                   as empty as the upper left, where the frame and the subject are
//   the field       the bare ground is one field, reaching the window's right or foot, with nothing of it trapped
//                   between things; at most a third of the world's cells carry a mark
//   a whole title   the band's name whole at its size, inside the window, or not there
//   one voice       the display face at its two sizes, no text and no number said twice in it

const U = 24;
const SIZES = [{width: 1536, height: 864}, {width: 1024, height: 768}, {width: 768, height: 864}, {width: 390, height: 844}];
const NAME = 33.0124, PERSON = 66.0248;

/** Each place, what is its subject (the one thing with the shadow at rest), and what may stand at the frame's corner. */
const PLACES = {
  home: {subject: '.home-own > .section', corner: '.home-own'},
  'new-repo': {subject: '.nr-box', corner: '.new-repo'},
  // The shared Places key is on the right. The work desk's own name anchors the left-hand subject.
  forge: {subject: '.desk > .desk-plane > .desk-box.held', corner: '.desk-box', anchor: '.forge-title'},
  git: {subject: '.issue-slot[aria-current="true"] .issue-card', corner: '.git-switch, .issue-card', anchor: '.git-title'},
  // (Server's desk may rest with a board before the one in hand at its edge (§6): a board of the room is what it is.)
  server: {subject: '.slide.full', corner: '.server-side, .slide'},
  inbox: {subject: '.inbox-thread', corner: '.inbox-index, .inbox-thread', anchor: '.inbox-title'},
  runtime: {subject: 'main#page', corner: '.page-head'},
  remote: {subject: 'main#page', corner: '.page-head'},
} as const;
type Place = keyof typeof PLACES;

/** What a frame holds, by numbers: run in the page. */
function frame({subject, corner, anchor}: {subject: string; corner: string; anchor?: string}) {
  const W = innerWidth, H = innerHeight;
  const veil = document.querySelector<HTMLElement>('.page-veil.out');
  const inSight = (el: Element) => {
    const r = el.getBoundingClientRect(), c = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H && !el.closest('[hidden], [inert]');
  };
  const all = [...document.querySelectorAll('body *')].filter(inSight);
  // One lens: nothing drawn larger or smaller than it is, nothing seen in perspective (a mark may turn).
  const scaled = all.filter((el) => {
    const c = getComputedStyle(el), m = new DOMMatrixReadOnly(c.transform === 'none' ? undefined : c.transform);
    const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
    return Math.abs(sx - 1) > .001 || Math.abs(sy - 1) > .001 || !['none', '1'].includes(c.scale) || c.perspective !== 'none' || ((c as unknown as {zoom?: string}).zoom ?? '1') !== '1';
  }).map((el) => el.className.toString().slice(0, 60));
  // The shadows cast (to the right and down: an underline drawn by a shadow is a line, not a shadow), and which are in
  // focus: over the veil, or with no veil out.
  const cast = all.flatMap((el) => {
    const s = getComputedStyle(el).boxShadow;
    const m = /(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/.exec(s);
    if (s === 'none' || s.includes('inset') || !m || Number(m[1]) <= 0 || Number(m[2]) <= 0) return [];
    const r = el.getBoundingClientRect();
    const over = !veil || el.closest('.file-tree, .me-pop, .search-results, .rail') !== null;
    return [{name: el.className.toString().slice(0, 60), x: Number(m[1]), y: Number(m[2]), blur: Number(m[3]), focus: over, box: [r.left, r.top, r.width, r.height]}];
  });
  const s = document.querySelector(subject)?.getBoundingClientRect() ?? null;
  // The display face's words in sight, each text as it is set, with its size (a person's initial in their mark, on the
  // rail or beside what they said, is a mark, not words).
  const display = [...(function* () {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement!, text = n.textContent!.trim();
      if (!text || el.closest('.rail, .tl-face, [aria-hidden="true"] .sr-only') || !/Display/.test(getComputedStyle(el).fontFamily)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0 && b.right > 0 && b.left < W && b.bottom > 0 && b.top < H);
      if (r.length && inSight(el)) yield {text, size: parseFloat(getComputedStyle(el).fontSize)};
    }
  })()];
  // Every size of type in sight, of words and of fields alike (DESIGN §3: three, one, two and four times).
  const sizes = new Set<number>();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement!;
    if (n.textContent!.trim() && !el.closest('.sr-only, script, style') && inSight(el)) sizes.add(Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100);
  }
  for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) if (inSight(el)) sizes.add(Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100);
  // Every line of words in the world, where its middle falls against the grid (DESIGN §3, whole cells: a line of type
  // is a cell of the grid, its middle on a row of the dots). Not a key's or a field's words (a thing's, centred in its
  // field), nor words on a name's line (they stand on its baseline: its servants), nor the frame's.
  const offGrid: string[] = [];
  const lines = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = lines.nextNode(); n; n = lines.nextNode()) {
    const el = n.parentElement!;
    if (!n.textContent!.trim() || !inSight(el) || el.closest('.sr-only, button, [role=button], [role=tab], [role=menuitem], kbd, input, textarea, [contenteditable], .rail, .band, .home-band, .bar, .chip, .state-chip, .lately-badge, .tl-face, .prompt, .screen')) continue;
    const c = getComputedStyle(el);
    if (Math.abs(parseFloat(c.fontSize) - 17) > .01 || Number(c.opacity) === 0) continue;
    let heard = false;
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).clipPath.startsWith('inset')) heard = true;
    if (heard) continue;
    const head = el.closest('.page-head, .board-head, .inbox-top, .issue-big-head');
    if (head && [...head.querySelectorAll('*')].some((k) => /Display/.test(getComputedStyle(k).fontFamily))) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    // Forge's compact code and its name have their own lines inside or immediately above the paper.
    // A Git diff similarly aligns to its sticky header or scrolled file lines. Check their local grids, not exemptions.
    const paper = el.closest('.forge-layout .desk .desk-box:not([data-kind])');
    const code = !!paper && !!el.closest('.desk-file > .sheet');
    const tag = !!paper && !!el.closest('.desk-label');
    const diffHead = el.closest('.git-diff-head'), diffLines = el.closest('.git-diff-lines');
    // A letter is set on its own local lines inside the accepted stock and measure.
    const letterLine = el.closest('.inbox-entry-by, .inbox-footer > p');
    const totals = el.closest('.git-totals');
    // A board's transcript stands on its foot; the trailing, 1px scroll target is not part of a line.
    const foot = el.closest('.board-talk > .timeline')?.querySelector(':scope > .tl-foot-mark');
    const pitch = code ? 19 : 24;
    const first = code ? paper!.getBoundingClientRect().top + 12 + pitch / 2
      : tag ? paper!.getBoundingClientRect().top - pitch / 2
      : diffHead ? diffHead.getBoundingClientRect().top + pitch / 2
      : diffLines ? diffLines.getBoundingClientRect().top + 8 + pitch / 2
      : totals ? totals.getBoundingClientRect().top + pitch / 2
      : letterLine ? letterLine.getBoundingClientRect().top + pitch / 2
      : foot ? foot.getBoundingClientRect().top - pitch / 2 : 12;
    // The 17px inline monospace times sit on the sentence's baseline, not on a separate 24px line.
    // Their text Range centers one pixel above the regular line's text Range; compare their shared baseline.
    const baseline = parseFloat(c.lineHeight) === 17 && el.matches('.tl-who > time, .bubble-time') ? 1 : 0;
    for (const b of range.getClientRects()) {
      if (b.width < 2 || b.top < 48 || b.left < 48 || b.bottom > H || b.right > W) continue;
      const line = b.top + b.height / 2 + baseline - first;
      const off = line - pitch * Math.round(line / pitch);
      if (Math.abs(off) > 1) offGrid.push(`"${n.textContent!.trim().slice(0, 24)}" ${off > 0 ? '+' : ''}${off.toFixed(1)}`);
    }
  }
  // What stands just past the frame's corner, where the eye is after a move.
  // (A cell and a half right of the rail, two cells under the band: 24 px a cell, the frame two cells each way.)
  const at = document.elementFromPoint(84, 96);
  const landed = !!at?.closest(corner);
  // How far that is from the place's visible name, rail control, or door to a far side.
  const from = anchor ? all.find((el) => el.matches(anchor))
    : all.find((el) => el.matches('.door')) ?? all.find((el) => el.matches('.rail .rail-item[aria-current="page"]'));
  const fr = from?.getBoundingClientRect(), lr = at?.closest(corner)?.getBoundingClientRect();
  const reach = fr && lr ? Math.hypot(Math.max(lr.left - (fr.left + fr.width / 2), 0, fr.left + fr.width / 2 - lr.right),
    Math.max(lr.top - (fr.top + fr.height / 2), 0, fr.top + fr.height / 2 - lr.bottom)) : Infinity;
  // The band's name of what is in hand: whole at its size, inside the window clear of its edge, or not there.
  const held = document.querySelector<HTMLElement>('.band-held');
  const title = held && inSight(held) && held.textContent ? (() => {
    const range = document.createRange();
    range.selectNodeContents(held);
    const r = range.getBoundingClientRect();
    return {whole: held.scrollWidth <= held.clientWidth, size: parseFloat(getComputedStyle(held).fontSize), left: r.left, right: r.right};
  })() : null;
  // The frame over what is called up: the available controls, not a hidden band's old bounding box.
  const frameControl = all.find((el) => el.matches('body > .rail'));
  const frameOver = !!veil && !!frameControl && Number(getComputedStyle(frameControl).zIndex) > Number(getComputedStyle(veil).zIndex);
  const quietPaper = all.filter((el) => el.matches('.forge-layout .desk .desk-box:not(.held):not([data-kind])')).map((el) => {
    const {left, top, right, bottom} = el.getBoundingClientRect();
    const c = getComputedStyle(el);
    // Away from the rounded corners, the sheet owns all of this ground-coloured strip.
    return {
      left, top, right, bottom,
      inset: Math.max(...[c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomLeftRadius, c.borderBottomRightRadius].map(parseFloat)),
    };
  });
  return {W, H, scaled, cast, subject: s && {x: s.left, y: s.top, w: s.width, h: s.height}, display, landed, reach, at: at?.className.toString() ?? '', title, frameOver, sizes: [...sizes], offGrid, quietPaper};
}

/** Each rule of a shot held at `place`'s rest. */
async function shot(app: App, place: Place, size: {width: number; height: number}, called = false) {
  const what = `${place}${called ? ' with File called up' : ''} at ${size.width}×${size.height}`;
  await expect(async () => {
    const f = await app.page.evaluate(frame, PLACES[place]);
    expect(f.scaled, `${what}: one lens, nothing drawn scaled`).toEqual([]);
    const focused = f.cast.filter((c) => c.focus);
    expect(focused.length, `${what}: one subject in focus (${JSON.stringify(f.cast)})`).toBe(1);
    const shade = place === 'forge' && !called ? 4 : place === 'inbox' ? 6 : U / 2;
    expect([focused[0]!.x, focused[0]!.y, focused[0]!.blur], `${what}: the one light's shadow`).toEqual([shade, shade, 0]);
    if (!called) {
      expect(f.subject, `${what}: its subject in sight`).not.toBeNull();
      expect(f.cast.length, `${what}: the shadow is the subject's (${JSON.stringify(f.cast)})`).toBe(1);
      const [x, y] = f.cast[0]!.box;
      expect([Math.abs(x! - f.subject!.x) < 1, Math.abs(y! - f.subject!.y) < 1], `${what}: the shadow is the subject's`).toEqual([true, true]);
      // One horizon: the subject stands on the grid (whole cells from the window's top left).
      for (const [edge, v] of [['left', f.subject!.x], ['top', f.subject!.y]] as const) {
        // Forge's paper starts at y=90; the name and the ground still keep the window grid.
        const origin = place === 'forge' && edge === 'top' ? 90 : 0;
        expect(Math.abs(v - origin - U * Math.round((v - origin) / U)), `${what}: the subject's ${edge} (${v}) on its grid`).toBeLessThan(1);
      }
      expect(f.landed, `${what}: the eye lands on what the place is, not ${f.at}`).toBe(true);
      // Within the parafovea of where the hand was (5° = 235 px at 0.0213° a px): found without a search.
      expect(f.reach, `${what}: what the place is within 5° of where the hand was`).toBeLessThanOrEqual(235);
    } else {
      expect(f.frameOver, `${what}: the frame control over the veil, in focus`).toBe(true);
    }
    // Every line of words on a cell of the grid (DESIGN §3, whole cells).
    expect(f.offGrid, `${what}: lines of words off the grid`).toEqual([]);
    // Inbox follows its own letter measure: dossier notes, ink and a single display name at two possible widths.
    const sizes = place === 'inbox' ? [13, 14, 17, 18, 20, 30, 38] : [17, NAME, PERSON];
    const displaySizes = place === 'inbox' ? [30, 38] : [NAME, PERSON];
    for (const size of f.sizes) expect(sizes.some((s) => Math.abs(size - s) < .01), `${what}: type at ${size}px, not one of the place's sizes`).toBe(true);
    for (const d of f.display) expect(displaySizes.some((s) => Math.abs(d.size - s) < .01), `${what}: "${d.text}" at ${d.size}px, not a display size`).toBe(true);
    const texts = f.display.map((d) => d.text);
    expect(texts.length, `${what}: no text said twice large (${texts.join(' | ')})`).toBe(new Set(texts).size);
    const numbers = texts.flatMap((t) => t.match(/#\d+/g) ?? []);
    expect(numbers.length, `${what}: no number said twice large (${texts.join(' | ')})`).toBe(new Set(numbers).size);
    // A title whole, at its size, inside the window clear of its edge.
    if (f.title) {
      expect(f.title.whole, `${what}: the band's name whole`).toBe(true);
      expect(Math.abs(f.title.size - NAME), `${what}: the band's name at a name's size`).toBeLessThan(.01);
      expect(f.title.left >= 6 && f.title.right <= f.W - 6, `${what}: the band's name inside the window`).toBe(true);
    }
  }).toPass({timeout: 5000});
  // On a desk (not a place that is one sheet: that sheet is its world, a close-up with no ground ahead of it), on a desk
  // screen (a phone's piece fills its world), the weight to the left of the world's middle where the subject stands
  // at the desk's edge. (Where a row's first sheet stands before it, that sheet is what can be done next, which
  // outranks the plane: §2, the order of sacrifice.)
  const f = await app.page.evaluate(frame, PLACES[place]);
  const desk = place !== 'runtime' && place !== 'remote';
  // What stands before the subject, when it is not at the desk's edge: the place's own side (Git's steps and new line),
  // a row's first sheet (Server's first board), or the place's index (Inbox's who wrote).
  const before = !called && f.subject && f.subject.x > 2 * U + .5 ? await app.page.evaluate(() => {
    const seen = (sel: string) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length > 0);
    return seen('.inbox-index') ? 'index' : seen('.git-side:not(.none)') ? 'side' : 'sheet';
  }) : null;
  // Look room (Thompson and Bowen; Palmer, Gardner and Wickens 2008): ahead at least behind, wherever the subject
  // stands. (Where the place's index stands before it, what can be done next outranks the plane, §2, the order of
  // sacrifice: Inbox's who-wrote beside the conversation where both fit.)
  if (desk && !called && size.width >= 1024 && f.subject && before !== 'index') {
    const ahead = f.W - (f.subject.x + f.subject.w + U / 2), behind = f.subject.x - 2 * U;
    expect(ahead, `${what}: the room ahead of the subject (${ahead}) at least the room behind it (${behind})`).toBeGreaterThanOrEqual(behind);
  }
  const atEdge = !called && size.width >= 1024 && !!f.subject && (f.subject.x <= 2 * U + .5 || before === 'side');
  if (atEdge && desk) expect(await across(app.page), `${what}: the weight left of the middle`).toBeLessThan(0);
  if (!atEdge) return;
  const rows = await emptiness(app.page), R = rows.length, C = rows[0]!.length;
  // The lean: the room ahead lies down and to the right, the open sides; the weight with the frame, up and left.
  const ul = emptyIn(rows, 0, R >> 1, 0, C >> 1), lr = emptyIn(rows, R >> 1, R, C >> 1, C);
  expect(lr, `${what}: the lower right (${lr.toFixed(2)} empty) at least as empty as the upper left (${ul.toFixed(2)})`).toBeGreaterThanOrEqual(ul);
  if (!desk) return;
  // The field: the bare ground one body, open to the right or the foot, nothing of it shut in between things.
  // Forge now has 12px seams between full-height sheets. A full 24px cell cannot witness that open corridor,
  // so resolve connectivity on smaller samples there; coverage and the lean still use the 24px grid.
  const pitch = place === 'forge' ? 4 : U;
  const field = pitch === U ? rows : await emptiness(app.page, pitch);
  // DESIGN §2: a counter inside a sheet belongs to that sheet. A quiet Forge paper uses ground paint, so its
  // wholly contained bare cells do not belong to the desk. Any cell crossing its boundary is still measured as drawn.
  const ground = f.quietPaper.length ? field.map((row, j) => [...row].map((cell, i) => {
    if (cell !== 'g') return cell;
    const x = 2 * U + i * pitch, y = 2 * U + j * pitch, right = x + pitch, bottom = y + pitch;
    return f.quietPaper.some(p => x >= p.left && right <= p.right && y >= p.top && bottom <= p.bottom &&
      ((x >= p.left + p.inset && right <= p.right - p.inset) || (y >= p.top + p.inset && bottom <= p.bottom - p.inset))) ? 'p' : cell;
  }).join('')) : field;
  const all = fields(ground), bare = all.reduce((n, c) => n + c.n, 0);
  expect(bare, `${what}: bare ground still visible`).toBeGreaterThan(0);
  expect(all[0]!.n / bare, `${what}: the bare ground one field`).toBeGreaterThanOrEqual(.95);
  expect(all[0]!.open, `${what}: the field open to the window's right or foot`).toBe(true);
  expect(all.filter((c) => !c.edge).reduce((n, c) => n + c.n, 0) / bare, `${what}: no ground trapped between things`).toBeLessThan(.01);
  // How much is marked: at most a third of the world's cells (a type area under half a page is the quiet one).
  const marked = 1 - emptyIn(rows, 0, R, 0, C);
  expect(marked, `${what}: ${Math.round(marked * 100)}% of the world marked`).toBeLessThanOrEqual(1 / 3);
}

test('every rest is a shot: in every place, at every width, one lens, one horizon, one subject in focus, the eye landing on what the place is, a whole title, one voice, three sizes of type, every line on the grid', async ({signedIn: app, another}) => {
  test.setTimeout(300_000);
  // Something in each place: a TODO, two repos, an issue under way with its work, a server's board with talk, a
  // conversation.
  await app.rail.go('home');
  await app.home.title(app.home.items.first()).pressSequentially('Fix: The tent leaks');
  await app.newRepo.make('hello', {template: 'C'});
  await app.newRepo.make('garden');
  await app.git.write('hello', 'Fix: Say hello louder', 'It whispers; it should say it out loud.');
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  // (And a second, written after it, in hand: a row, the box in full the last of it.)
  await app.git.write('hello', 'Feat: A second greeting');
  await app.rail.go('forge');
  const readme = app.forge.editor('README.md');
  const text = '# hello\n\nHELLO.\n';
  await expect(app.main.getByRole('region', {name: 'Files in hello', exact: true})).toBeVisible();
  await expect(readme).toHaveValue('# hello\n');
  await app.forge.editFile('README.md', text);
  // A fresh view confirms the fixture has saved the edit in the selected repo, not merely echoed a draft.
  await app.page.reload();
  await app.settled();
  await app.rail.go('forge');
  await expect(readme).toHaveValue(text);
  await app.server.make('Trip', `${app.handle}-trip`);
  await app.server.makeBoard('Packing');
  await app.server.post('Packing', 'Who brings the tent?');
  const bo = await another('Bo');
  await bo.inbox.named();
  await app.inbox.named();
  await app.inbox.writeTo(bo.handle, 'Question: are you coming on Saturday?');

  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    for (const place of Object.keys(PLACES) as Place[]) {
      await app.rail.go(place);
      if (place === 'forge') await app.forge.editor('README.md').focus();
      if (place === 'inbox') {
        const thread = app.inbox.thread(bo.handle);
        // Returning holds the same letter. On a narrow window the index is beside it, not a fallback to poke
        // before the authenticated letter has finished reading.
        await expect(thread).toBeInViewport({ratio: 1});
        await expect(thread.getByText('are you coming on Saturday?', {exact: true})).toBeInViewport({ratio: .8});
      }
      await shot(app, place, size);
    }
    // The global File tree is called up from Home; its rail stays over the world in focus.
    await app.rail.go('home');
    await app.file.openTree();
    await shot(app, 'home', size, true);
    await app.page.keyboard.press('Escape');
  }
});

// Three cards: write C, read what the compiler made, copy what QM made of it.
//
// Nothing explains itself at you. Each card carries one line of numbers under
// its title, and the Derivation link in the footer opens everything else for
// anyone who wants it.

import { readConfig } from './clang.js';

const $ = (id) => document.getElementById(id);

// Examples are not written here. They live in examples/*.c, and
// tools/gen_examples.py puts the same text into web/examples.json — one home
// for the source, and no claim about any result: the numbers appear when you
// press Compile, which is the only place they can be true.
let EXAMPLES = [];

// Filled in once the worker reports what this build is; the editor footer
// names the engine version next to whatever language the active tab holds.
let QM_VERSION = '';

async function loadExamples() {
  try {
    const response = await fetch(new URL('examples.json', import.meta.url),
                                { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    EXAMPLES = (await response.json()).examples || [];
  } catch {
    EXAMPLES = [];
  }
  return EXAMPLES;
}

const state = {
  worker: null,
  ready: false,
  busy: false,
  capabilities: null,
  view: 'asm',
  isa: null,
  // One tab per kernel you are working on. Each keeps its own source and its
  // own last result, so switching back shows what you left, not a blank card.
  tabs: [],
  activeId: null,
};

const TABS_KEY = 'qm.tabs';
const ACTIVE_KEY = 'qm.activeTab';

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || state.tabs[0];
}

// `state.result` used to be a field; it is now whatever the active tab holds.
Object.defineProperty(state, 'result', {
  get() { const tab = activeTab(); return tab ? tab.result : null; },
  set(value) { const tab = activeTab(); if (tab) tab.result = value; },
});

Object.defineProperty(state, 'clangAssembly', {
  get() { const tab = activeTab(); return tab ? (tab.clangAssembly || '') : ''; },
  set(value) { const tab = activeTab(); if (tab) tab.clangAssembly = value; },
});

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

const C_TYPES = /\b(uint(8|16|32|64)_t|int(8|16|32|64)_t|unsigned|signed|void|char|short|int|long|bool|_Bool|size_t)\b/g;
const C_KEYWORDS = /\b(for|while|do|if|else|return|break|continue|switch|case|default|static|inline|const|sizeof|struct|typedef|goto|extern|volatile|register)\b/g;

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function highlightC(code) {
  // Comments, strings and preprocessor lines are lifted out first; the token
  // passes below rewrite digits and would otherwise corrupt them. The
  // placeholder is fenced with U+0001, which cannot occur in a paste, so no
  // source text can be mistaken for one.
  const guarded = [];
  const hold = (html) => `g${guarded.push(html) - 1}z`;

  let out = escapeHtml(code)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
             (m) => hold(`<span class="tok-com">${m}</span>`))
    .replace(/^[ \t]*#[^\n]*/gm,
             (m) => hold(`<span class="tok-pp">${m}</span>`))
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
             (m) => hold(`<span class="tok-str">${m}</span>`));

  out = out
    .replace(/\b(0[xXbB][0-9a-fA-F]+|\d+)([uUlL]*)\b/g,
             '<span class="tok-num">$1$2</span>')
    .replace(C_TYPES, '<span class="tok-type">$&</span>')
    .replace(C_KEYWORDS, '<span class="tok-kw">$&</span>')
    .replace(/\b(__builtin_[a-z0-9_]+)\b/g, '<span class="tok-fn">$1</span>');

  return out.replace(/g(\d+)z/g, (_, i) => guarded[Number(i)]);
}

function highlightAsm(code) {
  // The overlay sits behind the textarea character for character, so this
  // colours in place rather than reflowing the way the listing panes do.
  // Same U+0001 fencing as above, for the same reason.
  const guarded = [];
  const hold = (html) => `\u0001g${guarded.push(html) - 1}z\u0001`;

  const out = escapeHtml(code)
    .replace(/^[ \t]*(?:[#;]+|\/\/)[^\n]*/gm,
             (m) => hold(`<span class="tok-com">${m}</span>`))
    .replace(/^[ \t]*\.[\w.]+/gm,
             (m) => hold(`<span class="tok-dir">${m}</span>`))
    .replace(/\$?\b0[xX][0-9a-fA-F]+\b|\$-?\d+\b/g,
             (m) => hold(`<span class="tok-num">${m}</span>`))
    .replace(/%\w+/g, (m) => hold(`<span class="tok-type">${m}</span>`));

  return out.replace(/\u0001g(\d+)z\u0001/g, (_, i) => guarded[Number(i)]);
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

// A listing is rendered as index / mnemonic / operands, the way a disassembler
// shows it.  The left column counts instructions rather than bytes: nothing
// here has been assembled, and a column of byte offsets would be invented.
function renderListing(text, functionName) {
  if (!text) return '<span class="hint">nothing here yet</span>';

  const rows = [];
  let index = 0;
  for (const raw of sliceFunction(text, functionName).split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')
        || trimmed.startsWith(';')) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="tok-com">${escapeHtml(trimmed)}</span></span>`);
      continue;
    }
    if (/^[\w.$]+:/.test(trimmed)) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="lbl">${escapeHtml(trimmed)}</span></span>`);
      continue;
    }
    // wasm text wraps the body in `(module` / `(func ...)`; those are the
    // shape of the file, not instructions, so they read like directives.
    if (trimmed.startsWith('(') || trimmed.startsWith(')')) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="tok-dir">${escapeHtml(trimmed)}</span></span>`);
      continue;
    }
    if (trimmed.startsWith('.')) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="tok-dir">${escapeHtml(trimmed)}</span></span>`);
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][\w.]*)\s*(.*)$/);
    if (!match) continue;
    index += 1;
    rows.push(`<span class="row">`
      + `<span class="addr">${String(index).padStart(3, ' ')}</span>`
      + `<span class="mn">${escapeHtml(match[1])}</span>`
      + `<span class="ops">${escapeHtml(match[2])}</span></span>`);
  }
  return rows.join('') || '<span class="hint">nothing to show</span>';
}

// Show the function, not the constant pool and section directives around it.
function sliceFunction(text, functionName) {
  if (!functionName) return text;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(`${functionName}:`));
  if (start < 0) return text;
  const body = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('.size') || /^[\w$]+:/.test(trimmed)) break;
    body.push(line);
  }
  return body.join('\n');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let nextTabId = 1;

function newTab(name, source) {
  return {
    id: `t${nextTabId++}`,
    // No extension by default: the language comes from what you paste, and a
    // tab labelled `.c` while it holds wasm is the confusing part.
    name: name || 'untitled',
    source: source || '',
    result: null,
    ranWith: null,
    clangAssembly: '',
    dirty: false,
  };
}

function persistTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(
      state.tabs.map((t) => ({ id: t.id, name: t.name, source: t.source }))));
    localStorage.setItem(ACTIVE_KEY, state.activeId || '');
  } catch {
    /* a full or blocked store must not stop the editor working */
  }
}

function restoreTabs() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
  } catch {
    stored = null;
  }

  if (Array.isArray(stored) && stored.length) {
    state.tabs = stored.map((t) => {
      const tab = newTab(t.name, t.source);
      if (t.id) tab.id = t.id;
      return tab;
    });
    // Keep generated ids clear of restored ones.
    const highest = Math.max(0, ...state.tabs
      .map((t) => Number(String(t.id).replace(/\D/g, '')) || 0));
    nextTabId = highest + 1;
    state.activeId = localStorage.getItem(ACTIVE_KEY) || state.tabs[0].id;
    if (!state.tabs.some((t) => t.id === state.activeId)) {
      state.activeId = state.tabs[0].id;
    }
    return true;
  }

  // One-tab migration from the single-source layout this replaces.
  const legacy = localStorage.getItem('qm.source');
  if (legacy) {
    const tab = newTab('kernel.c', legacy);
    state.tabs = [tab];
    state.activeId = tab.id;
    return true;
  }
  return false;
}

function renderTabs() {
  const list = $('tablist');
  list.innerHTML = state.tabs.map((tab) => `
    <div class="tab${tab.id === state.activeId ? ' is-active' : ''}${
      tab.dirty ? ' is-dirty' : ''}" data-id="${tab.id}" role="tab">
      <span class="name">${escapeHtml(tab.name)}</span>
      <span class="dot" aria-hidden="true"></span>
      ${state.tabs.length > 1
        ? `<button class="close" data-close="${tab.id}" title="Close"
                   aria-label="Close ${escapeHtml(tab.name)}">&times;</button>`
        : ''}
    </div>`).join('');

  // The strip scrolls, so a tab selected from the far end would otherwise sit
  // half outside it.
  const active = list.querySelector('.tab.is-active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  list.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (event.target.dataset.close) return;
      selectTab(el.dataset.id);
    });
  });
  list.querySelectorAll('.close').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(el.dataset.close);
    });
  });
}

function selectTab(id) {
  if (id === state.activeId) return;
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  state.activeId = id;
  $('source').value = tab.source;
  syncSource({ keepDirty: true });
  renderTabs();
  restoreCards();
  persistTabs();
}

function addTab(name, source) {
  const tab = newTab(name, source || '');
  state.tabs.push(tab);
  state.activeId = tab.id;
  $('source').value = tab.source;
  syncSource({ keepDirty: true });
  renderTabs();
  restoreCards();
  persistTabs();
  $('source').focus();
  return tab;
}

function closeTab(id) {
  if (state.tabs.length <= 1) return;
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  state.tabs.splice(index, 1);
  if (state.activeId === id) {
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    state.activeId = next.id;
    $('source').value = next.source;
    syncSource({ keepDirty: true });
    restoreCards();
  }
  renderTabs();
  persistTabs();
}

/** Repaint cards 2 and 3 from whatever the active tab last produced. */
function restoreCards() {
  const result = state.result;
  if (!result || !result.ok) {
    $('clang-listing').innerHTML =
      '<span class="hint">Press <b>Compile</b>.</span>';
    $('qm-listing').innerHTML =
      '<span class="hint">The minimized program appears here.</span>';
    $('compiled-sub').textContent = '— instructions';
    $('qm-sub').textContent = '— instructions';
    $('sel-isa-view').innerHTML = '';
    renderCompiledHeading();
    return;
  }
  fillTargets(result);
  renderCompiled(result);
  renderTakeaway();
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

// What the paste looks like, so the page can say so while you type.  The
// worker's `route` is what actually decides — this is a hint, and the result
// corrects it — but a page that calls a wasm listing "C" while the engine reads
// it as wasm is the confusing part, not the highlighting.
const LOOKS_LIKE_C =
  /^\s*#\s*(include|define)\b|\b(?:uint(?:8|16|32|64)_t|unsigned\s+long|int\b)[\s*]+\w+\s*\(|\breturn\b[^;\n]*;/m;

function detectLanguage(text) {
  if (!text.trim()) return null;
  if (LOOKS_LIKE_C.test(text)) return 'C';
  if (/local\.get|\.functype|\bi(32|64)\.(const|add|mul|and|or|xor|shl)\b/.test(text)) {
    return 'wasm32';
  }
  if (/%rdi|%rax|%eax/.test(text)
      || /^\s*(mov|imul|and|or|xor|shl|shr|pdep|pext)[qlwb]?\s/m.test(text)) {
    return 'x86-64';
  }
  return null;
}

function editorLanguage() {
  const detected = detectLanguage($('source').value);
  if (detected) return detected;
  const tab = activeTab();
  const name = (tab && tab.name) || '';
  if (name.endsWith('.wat')) return 'wasm32';
  if (name.endsWith('.s') || name.endsWith('.S')) return 'x86-64';
  return $('source').value.trim() ? 'C' : null;
}

function syncSource(options) {
  const code = $('source').value;
  const language = editorLanguage();
  const lines = code.split('\n');
  const shown = Math.max(lines.length, 14);
  $('highlight').innerHTML =
    (language === 'C' || !language ? highlightC(code) : highlightAsm(code))
    + '\n';
  $('gutter').textContent =
    Array.from({ length: shown }, (_, i) => i + 1).join('\n');
  $('line-count').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;

  // A pasted listing is not compiled, so the two controls that say how to
  // compile it have nothing to act on.  Leaving them live invites the reading
  // that they changed something.
  const compiles = language !== 'x86-64' && language !== 'wasm32';
  for (const id of ['ctl-target', 'ctl-opt']) {
    $(id).classList.toggle('off', !compiles);
    $(id).querySelector('select').disabled = !compiles;
  }

  const tab = activeTab();
  if (tab) {
    const changed = tab.source !== code;
    tab.source = code;
    if (changed && !(options && options.keepDirty)) {
      tab.dirty = true;
      renderTabs();
    }
    persistTabs();
  }
}

function setSource(code, name) {
  const tab = activeTab();
  if (tab && name) tab.name = name;
  $('source').value = code;
  syncSource({ keepDirty: true });
  if (tab) tab.dirty = false;
  renderTabs();
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function currentTarget() {
  if (!state.result || !state.result.ok) return null;
  const targets = state.result.targets || [];
  return targets.find((t) => t.name === state.isa && t.ok)
    || targets.find((t) => t.name === state.result.primary_target)
    || targets.find((t) => t.ok)
    || null;
}

function takeawayText() {
  const target = currentTarget();
  if (!target) return { text: '', kind: 'asm', name: 'kernel_qm.s' };
  if (state.view === 'c' || !target.asm) {
    return { text: target.c || '', kind: 'c', name: 'kernel_qm.c' };
  }
  // A wasm target hands back wasm text, so the file it downloads as has to be
  // a .wat — an assembler would reject it under any other name.
  const wat = target.asm_dialect === 'wasm32';
  return { text: target.asm, kind: 'asm',
           name: wat ? 'kernel_qm.wat' : 'kernel_qm.s' };
}

// What a run would be made of.  Comparing it against what the shown result was
// made of is how the page knows the listing on screen is no longer the one the
// controls describe.
function optionsSignature() {
  return [$('sel-opt').value, $('sel-target').value, $('sel-compiler').value,
          $('sel-observer').value, $('inp-mask').value].join('|');
}

function renderCompiledHeading() {
  // The heading follows the selector rather than the last run, so choosing -O3
  // is visible immediately; when that no longer matches what is on screen the
  // sub-line below says so, rather than the heading quietly lying.  Nothing
  // was compiled for a pasted listing, and the built-in frontend has no
  // optimization level at all — neither gets an -O it did not use.
  const result = state.result;
  const kind = result && result.ok ? result.frontend.frontend.kind : 'compiler';
  $('compiled-opt').textContent =
    kind === 'assembly' ? '(as pasted)'
      : kind === 'interpreter' ? ''
        : `(${$('sel-opt').value})`;
}

function renderCompiled(result) {
  const front = result.frontend;
  const stats = front.assembly_stats || {};
  const compile = front.compile || {};
  const isa = stats.isa || compile.listing_isa || compile.dialect;
  // Nothing was compiled when the paste was already a listing; stamping "-O2"
  // on somebody else's assembly would be inventing a provenance for it.
  const pasted = front.frontend.kind === 'assembly';

  renderCompiledHeading();

  const count = stats.available ? stats.instructions
                                : (front.reference_ops || {}).mean;
  const facts = [count == null ? '— instructions' : `${count} instructions`];
  const tab = activeTab();
  // Naming the knob that moved would be guesswork — several of them change
  // what a run produces — so this says only that the two no longer agree.
  if (!pasted && tab && tab.ranWith && tab.ranWith !== optionsSignature()) {
    facts.push('press Compile to update');
  }
  $('compiled-sub').innerHTML = facts
    .map((fact) => `<span>${escapeHtml(fact)}</span>`).join(' ');
  $('compiled-isa').textContent = isa || front.frontend.kind;
  const engine = front.frontend.title || '';
  $('compiled-engine').textContent = engine;
  $('compiled-engine').title = engine;
  const listing = pasted ? (front.assembly || '') : state.clangAssembly;
  $('clang-listing').innerHTML = listing
    ? renderListing(listing, pasted ? null : front.function.name)
    : '<span class="hint">this frontend produced no listing</span>';
}

function renderTakeaway() {
  const result = state.result;
  const target = currentTarget();
  const { text, kind } = takeawayText();

  // The listing shows the function body, the way the compiled card does.
  // Copy still hands over the whole file, directives included, so that what
  // leaves the page actually assembles.
  const emitted = result && result.ok
    ? `${result.frontend.function.name}_qm` : null;
  $('qm-listing').innerHTML = !text
    ? '<span class="hint">no program in the declared grammar</span>'
    : (kind === 'c' ? highlightC(text) : renderListing(text, emitted));

  if (!result || !result.ok || !target) {
    $('qm-sub').textContent = '— instructions';
    return;
  }

  const v = target.verification;
  const verdict = v
    ? `${v.pass ? '\u2713' : '\u2717'} ${v.matched.toLocaleString()}/${v.total.toLocaleString()}`
      + (v.exhaustive ? ' exact' : ' sampled')
    : '';
  // Each fact is its own span so a narrow screen breaks between them rather
  // than inside one — "256/256 exact" on its own line said nothing.
  const facts = [
    `${target.work} instruction${target.work === 1 ? '' : 's'}`,
    `${result.residual_freedom} solution${result.residual_freedom === 1 ? '' : 's'}`,
  ];
  if (verdict) facts.push(verdict);
  // Spacing separates them, not punctuation: a middot left at the end of a
  // wrapped line — or at the start of the next one — is the untidy bit.
  $('qm-sub').innerHTML = facts
    .map((fact) => `<span>${escapeHtml(fact)}</span>`).join(' ');
}

function fillTargets(result) {
  const select = $('sel-isa-view');
  select.innerHTML = (result.targets || []).map((t) => {
    const title = (t.isa && t.isa.title) || t.name;
    const label = t.ok ? `${title} \u00b7 ${t.work} op${t.work === 1 ? '' : 's'}`
                       : `${title} \u00b7 —`;
    return `<option value="${t.name}"${t.ok ? '' : ' disabled'}>`
      + `${escapeHtml(label)}</option>`;
  }).join('');
  state.isa = result.primary_target;
  select.value = state.isa;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function currentOptions() {
  const observer = $('sel-observer').value === 'mask:custom'
    ? `mask:${$('inp-mask').value || '0xFFFFFFFFFFFFFFFF'}`
    : $('sel-observer').value;
  return {
    frontend: $('sel-compiler').value,
    opt: $('sel-opt').value,
    source_target: $('sel-target').value,
    observer,
  };
}

function onOptionChanged() {
  renderCompiledHeading();
  if (state.result && state.result.ok) renderCompiled(state.result);
}

function optimize() {
  if (!state.ready || state.busy) return;
  const source = $('source').value.trim();
  if (!source) return;

  state.busy = true;
  $('btn-optimize').disabled = true;
  $('foot-note').textContent = 'compiling…';
  state.worker.postMessage({ type: 'solve', source, options: currentOptions() });
}

const FOOT_DEFAULT =
  'All compilation happens in your browser. No code is sent to any server.';

function status(text) {
  $('foot-note').textContent = text || FOOT_DEFAULT;
}

let toastTimer = null;
function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 1600);
}

async function copyOutput() {
  const { text } = takeawayText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('copied');
  } catch {
    toast('clipboard unavailable', true);
  }
}

function downloadOutput() {
  const { text, name } = takeawayText();
  if (!text) return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function openDialog(title, html) {
  $('dlg-title').textContent = title;
  $('dlg-body').innerHTML = html;
  $('dlg').showModal();
}

async function showExamples() {
  if (!EXAMPLES.length) await loadExamples();
  openDialog('Examples', EXAMPLES.length
    ? '<div class="examples">' + EXAMPLES.map((ex, i) =>
        `<button class="btn ex" data-i="${i}">${escapeHtml(ex.file)}</button>`)
        .join('') + '</div>'
    : '<p class="note">examples.json could not be loaded</p>');
  $('dlg-body').querySelectorAll('.ex').forEach((el) => {
    el.addEventListener('click', () => {
      const example = EXAMPLES[Number(el.dataset.i)];
      const existing = state.tabs.find((t) => t.name === example.file);
      if (existing) {
        selectTab(existing.id);
        setSource(example.source, example.file);
      } else if (activeTab() && !activeTab().source.trim()) {
        setSource(example.source, example.file);
      } else {
        addTab(example.file, example.source);
        renderTabs();
      }
      $('dlg').close();
      optimize();
    });
  });
}

function showDetails() {
  const result = state.result;
  if (!result) return;
  if (!result.ok) {
    openDialog('Error',
               `<pre>${escapeHtml(result.error.text || result.error.message)}</pre>`);
    return;
  }

  const rows = (result.derivation || [])
    .map((d) => `<tr><th>${escapeHtml(d.step)}</th><td>${escapeHtml(d.value)}</td></tr>`)
    .join('');
  const targets = (result.targets || []).map((t) => (t.ok
    ? `<tr><th>${escapeHtml(t.name)}</th><td>span ${t.span} · work ${t.work}`
      + ` · ${escapeHtml(t.instructions.join(' '))}</td></tr>`
    : `<tr><th>${escapeHtml(t.name)}</th><td>${escapeHtml(t.reason || 'cannot lower')}</td></tr>`))
    .join('');
  const recognized = (result.recognition || []).join(', ');
  const versions = Object.entries(result.versions || {})
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');
  const engine = result.frontend.frontend.title || '';

  openDialog(result.frontend.function.signature || 'Details', `
    <table>${rows}</table>
    <h4>Targets</h4><table>${targets}</table>
    ${recognized
      ? `<h4>Recognized</h4><table><tr><th>primitive</th>`
        + `<td>${escapeHtml(recognized)}</td></tr></table>`
      : ''}
    <h4>Build</h4><table>
      ${engine ? `<tr><th>frontend</th><td>${escapeHtml(engine)}</td></tr>` : ''}
      ${versions}
    </table>
  `);
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

function fillSettings(capabilities) {
  $('sel-compiler').innerHTML = capabilities.frontends
    .filter((f) => f.name !== 'precompiled')
    .map((f) => `<option value="${f.name}"${f.name === 'clang' ? ' selected' : ''}>${
      f.name === 'clang' ? 'Clang (WASM)' : escapeHtml(f.title)}</option>`)
    .join('');

  $('sel-observer').innerHTML = capabilities.observers
    .map((o) => `<option value="${o.spec}">${escapeHtml(o.label)}</option>`)
    .join('') + '<option value="mask:custom">Custom bit mask…</option>';

  QM_VERSION = capabilities.versions.qm;
  status();
}

function onMessage(event) {
  const msg = event.data;

  if (msg.type === 'progress') { status(msg.message); return; }
  if (msg.type === 'notice') { toast(msg.message, true); return; }

  if (msg.type === 'ready') {
    state.ready = true;
    state.capabilities = msg.capabilities;
    fillSettings(msg.capabilities);
    $('settings-note').textContent = msg.clang.configured === false
      ? 'No Clang bundle configured; the built-in C subset frontend is used.'
      : `Clang/WASM loads on the first Compile. Listing: ${msg.clang.listing}.`;
    status();
    $('btn-optimize').disabled = false;
    return;
  }

  if (msg.type === 'compile-error') {
    state.clangAssembly = '';
    $('clang-listing').innerHTML =
      `<span class="tok-com">${escapeHtml(msg.stderr)}</span>`;
    return;
  }

  if (msg.type === 'done') {
    state.busy = false;
    $('btn-optimize').disabled = false;
    state.result = msg.result;

    if (!msg.result.ok) {
      state.clangAssembly = '';
      $('qm-listing').innerHTML =
        `<span class="tok-com">${escapeHtml(
          msg.result.error.text || msg.result.error.message)}</span>`;
      $('qm-sub').textContent = 'no result';
      status('error');
      toast(msg.result.error.message, true);
      return;
    }

    state.clangAssembly = (msg.result.compiled && msg.result.compiled.assembly) || '';
    const tab = activeTab();
    if (tab) {
      tab.ranWith = optionsSignature();
      tab.dirty = false;
      // Name the tab after the kernel, in the language it turned out to be.
      const name = msg.result.frontend.function.name;
      const listing = msg.result.frontend.frontend.listing;
      const suffix = listing === 'wasm32' ? '.wat'
        : listing === 'x86-64' ? '.s' : '.c';
      if (name && /^untitled/.test(tab.name)) tab.name = `${name}${suffix}`;
    }
    renderTabs();
    fillTargets(msg.result);
    renderCompiled(msg.result);
    renderTakeaway();
    status();
    return;
  }

  if (msg.type === 'fatal') {
    state.busy = false;
    $('btn-optimize').disabled = false;
    status('failed');
    toast(msg.message, true);
  }
}

// ---------------------------------------------------------------------------

const FALLBACK_SOURCE = `#include <stdint.h>

uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << i) - 1)) << (8 * i);

    return r;
}
`;

function init() {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('src');
  const restored = restoreTabs();

  if (!restored) {
    const tab = newTab('kernel.c', FALLBACK_SOURCE);
    state.tabs = [tab];
    state.activeId = tab.id;
  }
  if (fragment) {
    try {
      const shared = decodeURIComponent(escape(atob(fragment)));
      const tab = newTab('shared.c', shared);
      state.tabs.push(tab);
      state.activeId = tab.id;
    } catch {
      /* a malformed link should not stop the editor coming up */
    }
  }

  $('source').value = activeTab().source;
  syncSource({ keepDirty: true });
  activeTab().dirty = false;
  renderTabs();
  renderCompiledHeading();

  // The first example replaces the placeholder only if nothing was restored or
  // shared, so a returning visitor never loses what they had.
  loadExamples().then((examples) => {
    if (!restored && !fragment && examples.length) {
      setSource(examples[0].source, examples[0].file);
    }
  });

  const editor = $('source');
  editor.addEventListener('input', syncSource);
  editor.addEventListener('scroll', () => {
    $('highlight').scrollTop = editor.scrollTop;
    $('highlight').scrollLeft = editor.scrollLeft;
    $('gutter').scrollTop = editor.scrollTop;
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const at = editor.selectionStart;
      editor.value = `${editor.value.slice(0, at)}    `
        + editor.value.slice(editor.selectionEnd);
      editor.selectionStart = editor.selectionEnd = at + 4;
      syncSource();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      optimize();
    }
    if ((event.metaKey || event.ctrlKey) && event.altKey
        && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      const index = state.tabs.findIndex((t) => t.id === state.activeId);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = (index + step + state.tabs.length) % state.tabs.length;
      selectTab(state.tabs[next].id);
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey
        && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copyOutput();
    }
  });

  $('btn-optimize').addEventListener('click', optimize);
  $('btn-newtab').addEventListener('click', () => addTab());
  $('btn-examples').addEventListener('click', showExamples);
  $('btn-copy').addEventListener('click', copyOutput);
  $('btn-details').addEventListener('click', showDetails);
  $('btn-settings').addEventListener('click', () => $('settings').showModal());
  $('settings-close').addEventListener('click', () => $('settings').close());
  $('dlg-close').addEventListener('click', () => $('dlg').close());
  $('sel-observer').addEventListener('change', (event) => {
    $('inp-mask').disabled = event.target.value !== 'mask:custom';
    onOptionChanged();
  });
  for (const id of ['sel-opt', 'sel-target', 'sel-compiler']) {
    $(id).addEventListener('change', onOptionChanged);
  }
  $('inp-mask').addEventListener('input', onOptionChanged);
  $('sel-isa-view').addEventListener('change', (event) => {
    state.isa = event.target.value;
    renderTakeaway();
  });
  $('chk-intrinsics').addEventListener('change', (event) => {
    state.view = event.target.checked ? 'c' : 'asm';
    renderTakeaway();
  });

  state.worker = new Worker(new URL('worker.js', import.meta.url),
                            { type: 'module' });
  state.worker.addEventListener('message', onMessage);
  state.worker.postMessage({
    type: 'boot',
    search: location.search,
    config: readConfig(location.search),
  });
  status('starting the engine…');
}

init();

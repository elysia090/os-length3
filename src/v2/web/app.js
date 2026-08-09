// Two cards: paste a kernel, take the minimized program.
//
// There used to be a middle one showing what Clang made of the paste, with its
// own target and optimization controls. It was a second compile whose only job
// was display, and the minimized program is now the single thing this page is
// about — the artifact, viewable as any of the machines it lowers to, or as
// the codec itself.
//
// Nothing explains itself at you. Each card carries one line of numbers under
// its title, and the Derivation link in the footer opens everything else for
// anyone who wants it.

import { readConfig } from './clang.js';

const $ = (id) => document.getElementById(id);

// Examples are not written here. They live in examples/*.c, and
// tools/gen_examples.py puts the same text into web/examples.json — one home
// for the source, and no claim about any result: the numbers appear after the
// source has been analysed, which is the only place they can be true.
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
  options: { frontend: 'clang', observer: 'exact' },
  view: 'asm',
  isa: null,
  // The one solve currently in flight. Its source and tab are captured so a
  // late worker reply cannot overwrite a different tab or a newer edit.
  solve: null,
  // An edit that landed while a solve was running.
  pending: false,
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

// `main` belongs to a tab's last successful analysis, not to the editor as a
// whole. Keeping it beside the result makes Run/Compile stable across tabs.
Object.defineProperty(state, 'hasMain', {
  get() { const tab = activeTab(); return tab ? Boolean(tab.hasMain) : false; },
  set(value) { const tab = activeTab(); if (tab) tab.hasMain = Boolean(value); },
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
// A program can be long — the codec view of a dynamic gather is tens of
// thousands of instructions — and one DOM row each would hang the page. Past
// this many rows the rest is elided *on screen only*: Copy still hands over
// every line, because the whole thing is the program.
const MAX_ROWS = 3000;

function renderListing(text, functionName) {
  if (!text) return '<span class="hint">nothing here yet</span>';

  const rows = [];
  let index = 0;
  const lines = sliceFunction(text, functionName).split('\n');
  for (const raw of lines) {
    if (rows.length >= MAX_ROWS) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="hint">… ${(lines.length - rows.length).toLocaleString()}`
        + ` more lines. Copy takes all of them.</span></span>`);
      break;
    }
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
    // The codec view is a hex dump of the artifact: an offset and its bytes.
    // The offset belongs in the address column, because unlike a listing's
    // index it is a real one — these are the bytes of the file.
    const dump = trimmed.match(/^([0-9a-f]{8})\s\s((?:[0-9a-f]{2} ?)+)$/);
    if (dump) {
      rows.push(`<span class="row">`
        + `<span class="addr wide">${dump[1]}</span>`
        + `<span class="ops">${dump[2]}</span></span>`);
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
    hasMain: false,
    runReady: false,
    ranWith: null,
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
      tab.dirty ? ' is-dirty' : ''}" data-id="${tab.id}" role="tab"
         aria-selected="${tab.id === state.activeId}"
         tabindex="${tab.id === state.activeId ? '0' : '-1'}">
      <span class="name">${escapeHtml(tab.name)}</span>
      <span class="dot" aria-hidden="true"></span>
      <button class="close" data-close="${tab.id}" title="Close"
              aria-label="Close ${escapeHtml(tab.name)}"
              ${state.tabs.length > 1 ? '' : 'disabled'}>&times;</button>
    </div>`).join('');

  list.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (event.target.dataset.close) return;
      selectTab(el.dataset.id);
    });
    el.addEventListener('keydown', (event) => {
      const index = state.tabs.findIndex((tab) => tab.id === el.dataset.id);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = (index + step + state.tabs.length) % state.tabs.length;
        selectTab(state.tabs[next].id);
        list.querySelector(`[data-id="${state.activeId}"]`)?.focus();
      } else if (event.key === 'Delete' && state.tabs.length > 1) {
        event.preventDefault();
        closeTab(el.dataset.id);
        list.querySelector(`[data-id="${state.activeId}"]`)?.focus();
      }
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
  if (!tab.result || tab.dirty) scheduleCompile();
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
  scheduleCompile();
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
    if (!next.result || next.dirty) scheduleCompile();
  }
  renderTabs();
  persistTabs();
}

/** Repaint cards 2 and 3 from whatever the active tab last produced. */
function restoreCards() {
  const result = state.result;
  if (!result || !result.ok) {
    $('qm-listing').innerHTML =
      '<span class="hint">The minimized program appears here.</span>';
    $('qm-sub').textContent = '— instructions';
    $('sel-isa-view').innerHTML = '';
    renderRunControls();
    return;
  }
  fillTargets(result);
  renderTakeaway();
  renderRunControls();
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

  const tab = activeTab();
  if (tab) {
    const changed = tab.source !== code;
    tab.source = code;
    if (changed && !(options && options.keepDirty)) {
      tab.dirty = true;
      tab.hasMain = false;
      tab.runReady = false;
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
  scheduleCompile();
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
  // a .wat — an assembler would reject it under any other name.  The codec
  // view is not a language at all: it is the artifact's bytes, written out,
  // and calling it a .s would be claiming an assembler could read it.
  if (target.name === 'codec') {
    return { text: target.asm, kind: 'asm', name: 'kernel_qm.codec.txt' };
  }
  const wat = target.asm_dialect === 'wasm32';
  return { text: target.asm, kind: 'asm',
           name: wat ? 'kernel_qm.wat' : 'kernel_qm.s' };
}

// What a run would be made of.  Comparing it against what the shown result was
// made of is how the page knows the listing on screen is no longer the one the
// controls describe.
function optionsSignature() {
  return `${state.options.frontend}|${state.options.observer}`;
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
  return { ...state.options };
}

function optimize() {
  if (!state.ready || state.busy) return;
  const source = $('source').value;
  if (!source.trim()) return;

  clearTimeout(autoTimer);
  autoTimer = null;
  state.busy = true;
  state.pending = false;
  state.solve = {
    tabId: state.activeId,
    source,
    options: optionsSignature(),
  };
  renderRunControls();
  $('foot-note').textContent = 'compiling…';
  state.worker.postMessage({
    type: 'solve', source, options: currentOptions(),
  });
}

// Typing is the only thing that starts a compile now; there is no button. The
// delay is long enough that a burst of keystrokes is one solve rather than
// twenty, and `state.pending` remembers an edit that arrived while the last
// one was still running so nothing typed is ever left unanswered.
const AUTO_DELAY = 700;
let autoTimer = null;

// One place for "the worker stopped": it clears the flag, repaints Run, and
// picks up an edit that arrived while it was busy. Three call sites used to
// re-enable a Compile button each and none of them knew about the queue.
function finishBusy() {
  state.busy = false;
  if (state.pending) { scheduleCompile(); return; }
  renderRunControls();
}

function scheduleCompile() {
  clearTimeout(autoTimer);
  autoTimer = null;
  if (!$('source').value.trim()) {
    state.pending = false;
    renderRunControls();
    return;
  }
  state.pending = true;
  renderRunControls();
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (state.busy) return;
    state.pending = false;
    optimize();
  }, AUTO_DELAY);
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

// --------------------------------------------------------------------------
// Running the minimized program
//
// The lowered sequence is a live Python object and never crosses to this side,
// so the answer comes from the worker that built it.  The page had been able
// to show a program and not to try it.
// --------------------------------------------------------------------------

function termWrite(text, className) {
  const out = $('term-out');
  const line = document.createElement('span');
  if (className) line.className = className;
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function runProgram() {
  // Automatic analysis prewarms an exact source snapshot: minimized artifact,
  // import-only main driver and VM. Run only instantiates that snapshot.
  const tab = activeTab();
  if (state.busy || state.pending || !state.ready || !tab
      || tab.dirty || !tab.hasMain || !tab.runReady) return;
  const stdin = $('term-in').value;
  $('term-in').value = '';
  state.busy = true;
  renderRunControls();
  termWrite(stdin ? `> ${stdin}\n` : '> ', 'term-echo');
  status('running main through the minimized artifact…');
  state.worker.postMessage({ type: 'exec', source: tab.source, stdin });
}

function renderRunControls() {
  const tab = activeTab();
  const canRun = state.hasMain && tab && tab.runReady && !tab.dirty;
  $('term').hidden = !canRun;
  $('run-label').textContent = 'Run';
  const hasSource = Boolean($('source').value.trim());
  $('btn-run').disabled = state.busy || state.pending || !state.ready
    || !hasSource || !canRun;
}

function formatElapsed(value) {
  const elapsed = Math.max(0, Number(value) || 0);
  if (elapsed < 10) return elapsed.toFixed(2).replace(/\.?0+$/, '');
  return String(Math.round(elapsed));
}

function showRunResult(result) {
  if (!result.ok) {
    termWrite(`${result.error}\n`, 'term-err');
    status();
    return;
  }
  if (result.stdout) termWrite(result.stdout);
  const elapsed = formatElapsed(result.elapsed_ms);
  // Keep the artifact fact, but make completion and elapsed wall time the
  // stable line instead of exposing a process-like exit record for success.
  const via = result.ran
    ? ` · ${result.ran.toLocaleString()} call${result.ran === 1 ? '' : 's'}`
      + ' through the codec'
    : '';
  const exit = result.code ? ` · exit ${result.code}` : '';
  termWrite(`Done. [${elapsed}ms]${exit}${via}\n`, 'term-echo');
  status();
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
  $('dlg-title').hidden = false;
  $('dlg-title-action').hidden = true;
  $('dlg-body').innerHTML = html;
  $('dlg').showModal();
}

function examplesMarkup() {
  return '<div class="examples">'
    + '<button class="btn ex new-tab" data-new-tab="1" '
    + 'aria-label="New tab">+</button>'
    + EXAMPLES.map((ex, i) =>
        `<button class="btn ex" data-i="${i}">${escapeHtml(ex.file)}</button>`)
        .join('')
    + '</div>';
}

async function showExamples() {
  openDialog('New tab', examplesMarkup());
  $('dlg-title').hidden = true;
  $('dlg-title-action').hidden = false;
  wireExamples();
  if (!EXAMPLES.length) {
    await loadExamples();
    if (!$('dlg').open) return;             // closed while it was loading
    $('dlg-body').innerHTML = examplesMarkup()
      + (EXAMPLES.length ? ''
         : '<p class="note">examples.json could not be loaded</p>');
    wireExamples();
  }
}

function wireExamples() {
  $('dlg-body').querySelectorAll('.ex').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.newTab) {
        addTab();
        $('dlg').close();
        return;
      }
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
  // A paste of several functions analyses one of them.  Saying which, and
  // what was wrong with the rest, is the difference between a choice and a
  // guess — and the header above already names the one that was taken.
  const others = (result.frontend.other_functions || [])
    .map((f) => `<tr><th>${escapeHtml(f.name)}</th>`
      + `<td>${escapeHtml(f.reason)}</td></tr>`)
    .join('');

  openDialog(result.frontend.function.signature || 'Details', `
    <table>${rows}</table>
    <h4>Targets</h4><table>${targets}</table>
    ${others ? `<h4>Not analysed</h4><table>${others}</table>` : ''}
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

function acceptCapabilities(capabilities) {
  QM_VERSION = capabilities.versions.qm;
  status();
}

function onMessage(event) {
  const msg = event.data;

  if (msg.type === 'progress') { status(msg.message); return; }
  if (msg.type === 'notice') { toast(msg.message, true); return; }
  if (msg.type === 'ran') {
    const tab = activeTab();
    if (msg.result.stale && tab) tab.runReady = false;
    finishBusy();
    showRunResult(msg.result);
    if (msg.result.stale) scheduleCompile();
    return;
  }

  if (msg.type === 'ready') {
    state.ready = true;
    state.capabilities = msg.capabilities;
    acceptCapabilities(msg.capabilities);
    status();
    finishBusy();
    // The paste that was restored from the last session has never been through
    // the engine, so the first solve starts as soon as the engine is up.
    scheduleCompile();
    return;
  }

  if (msg.type === 'compile-error') {
    toast(msg.stderr.split('\n')[0] || 'compile error', true);
    return;
  }

  if (msg.type === 'done') {
    const request = state.solve;
    state.solve = null;
    const tab = request
      ? state.tabs.find((candidate) => candidate.id === request.tabId)
      : activeTab();

    // An edit made during this solve is already queued. Discard this stale
    // answer instead of briefly presenting it as the answer to the new text.
    if (!tab || (request && tab.source !== request.source)) {
      finishBusy();
      return;
    }

    tab.hasMain = Boolean(msg.has_main);
    tab.runReady = Boolean(msg.run_ready);
    tab.result = msg.result;
    tab.ranWith = request ? request.options : optionsSignature();
    tab.dirty = false;

    // A solve may finish after the user switches tabs. Store it on its own
    // tab, but never paint it into the tab now visible.
    if (tab.id !== state.activeId) {
      finishBusy();
      renderTabs();
      persistTabs();
      return;
    }

    if (!msg.result.ok) {
      finishBusy();
      $('qm-listing').innerHTML =
        `<span class="tok-com">${escapeHtml(
          msg.result.error.text || msg.result.error.message)}</span>`;
      $('qm-sub').textContent = 'no result';
      // There is no program to run any more, and leaving Run live would offer
      // to evaluate the previous paste's answer under this one's heading.
      renderRunControls();
      status('error');
      toast(msg.result.error.message, true);
      return;
    }

    if (tab) {
      // Name the tab after the kernel, in the language it turned out to be.
      const name = msg.result.frontend.function.name;
      const listing = msg.result.frontend.frontend.listing;
      const suffix = listing === 'wasm32' ? '.wat'
        : listing === 'x86-64' ? '.s' : '.c';
      if (name && /^untitled/.test(tab.name)) tab.name = `${name}${suffix}`;
    }
    renderTabs();
    fillTargets(msg.result);
    renderTakeaway();
    renderRunControls();

    finishBusy();
    status();
    // A paste of several functions answers about one of them.  Say so, once,
    // rather than letting the reader assume the whole file was minimized.
    const skipped = (msg.result.frontend.other_functions || []).length;
    if (skipped) {
      toast(`analysed ${msg.result.frontend.function.name} — `
            + `${skipped} other function${skipped === 1 ? '' : 's'} skipped`);
    }
    return;
  }

  if (msg.type === 'fatal') {
    finishBusy();
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

  // The first example replaces the placeholder only if nothing was restored or
  // shared, so a returning visitor never loses what they had.
  loadExamples().then((examples) => {
    if (!restored && !fragment && examples.length) {
      setSource(examples[0].source, examples[0].file);
    }
  });

  const editor = $('source');
  editor.addEventListener('input', () => { syncSource(); scheduleCompile(); });
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

  // A desktop double-click on panel chrome turns the two working columns into
  // one wide reading surface; a second double-click restores the pair. Code,
  // tabs and controls keep their native double-click behaviour (word
  // selection, tab actions, and so on).
  const desktopPanels = matchMedia('(min-width: 1061px)');
  const board = document.querySelector('.board');
  const cards = Array.from(board.querySelectorAll('.card'));
  const restorePanelPair = () => {
    board.classList.remove('is-focused');
    cards.forEach((card) => {
      card.classList.remove('is-expanded');
      card.setAttribute('aria-expanded', 'false');
    });
  };
  const togglePanel = (card) => {
    if (!desktopPanels.matches) return;
    const restore = card.classList.contains('is-expanded');
    restorePanelPair();
    if (!restore) {
      board.classList.add('is-focused');
      card.classList.add('is-expanded');
      card.setAttribute('aria-expanded', 'true');
    }
  };
  cards.forEach((card) => {
    card.setAttribute('aria-expanded', 'false');
    card.addEventListener('dblclick', (event) => {
      if (event.target.closest(
        'textarea, pre, input, button, select, .tabs, .terminal')) return;
      togglePanel(card);
    });
  });
  desktopPanels.addEventListener('change', (event) => {
    if (!event.matches) restorePanelPair();
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

  $('btn-run').addEventListener('click', runProgram);
  $('btn-newtab').addEventListener('click', showExamples);
  $('btn-copy').addEventListener('click', copyOutput);
  $('term-in').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runProgram(); }
  });
  $('btn-details').addEventListener('click', showDetails);
  $('dlg-title-action').addEventListener('click', () => {
    addTab();
    $('dlg').close();
  });
  $('dlg-close').addEventListener('click', () => $('dlg').close());
  $('sel-isa-view').addEventListener('change', (event) => {
    state.isa = event.target.value;
    renderTakeaway();
    renderRunControls();
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

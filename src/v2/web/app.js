// Three cards: write C, read what the compiler made, copy what QM made of it.
//
// Nothing explains itself at you. Each card carries one line of numbers under
// its title, and the Derivation link in the footer opens everything else for
// anyone who wants it.

import { readConfig } from './clang.js';

const $ = (id) => document.getElementById(id);

const EXAMPLES = [
  {
    name: 'ranks8',
    note: '502 solutions tied',
    code: `#include <stdint.h>

uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << i) - 1)) << (8 * i);

    return r;
}
`,
  },
  {
    name: 'inclusive_rank8',
    note: 'uniquely forced',
    code: `#include <stdint.h>

uint64_t inclusive_rank8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            m & ((1u << (i + 1)) - 1)) << (8 * i);

    return r;
}
`,
  },
  {
    name: 'quote_state_before8',
    note: 'carry-less convolution',
    code: `#include <stdint.h>

uint64_t quote_state_before8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i) {
        unsigned p = __builtin_popcount(m & ((1u << i) - 1)) & 1;
        r |= (uint64_t)(p * 0xFF) << (8 * i);
    }

    return r;
}
`,
  },
  {
    name: 'select8',
    note: 'dynamic permutation',
    code: `#include <stdint.h>

uint64_t select8(uint8_t m)
{
    uint64_t r = 0;
    unsigned j = 0;

    for (unsigned i = 0; i < 8; ++i)
        if ((m >> i) & 1)
            r |= (uint64_t)i << (8 * j++);

    return r;
}
`,
  },
  {
    name: 'run_ids8',
    note: 'lane-local step first',
    code: `#include <stdint.h>

uint64_t run_ids8(uint8_t m)
{
    uint8_t starts = m & ~(uint8_t)(m << 1);
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(
            starts & ((1u << (i + 1)) - 1)) << (8 * i);

    return r;
}
`,
  },
  {
    name: 'morton_dilate16',
    note: 'pure linear map',
    code: `#include <stdint.h>

uint32_t morton_dilate16(uint16_t x)
{
    uint32_t r = 0;

    for (unsigned i = 0; i < 16; ++i)
        if ((x >> i) & 1)
            r |= 1u << (2 * i);

    return r;
}
`,
  },
];

const state = {
  worker: null,
  ready: false,
  busy: false,
  capabilities: null,
  result: null,
  clangAssembly: '',
  view: 'asm',
  isa: null,
};

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
  // passes below rewrite digits and would otherwise corrupt them. The index is
  // wrapped in letters so the digit pass sees no word boundary.
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
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="tok-com">${escapeHtml(trimmed)}</span></span>`);
      continue;
    }
    if (/^[\w.$]+:/.test(trimmed)) {
      rows.push(`<span class="row"><span class="addr"></span>`
        + `<span class="lbl">${escapeHtml(trimmed)}</span></span>`);
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
// Editor
// ---------------------------------------------------------------------------

function syncSource() {
  const code = $('source').value;
  const lines = code.split('\n');
  const shown = Math.max(lines.length, 14);
  $('highlight').innerHTML = highlightC(code) + '\n';
  $('gutter').textContent =
    Array.from({ length: shown }, (_, i) => i + 1).join('\n');
  $('line-count').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
  localStorage.setItem('qm.source', code);
}

function setSource(code) {
  $('source').value = code;
  syncSource();
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
  return { text: target.asm, kind: 'asm', name: 'kernel_qm.s' };
}

function renderCompiled(result) {
  const front = result.frontend;
  const stats = front.assembly_stats || {};
  const compile = front.compile || {};
  const isa = stats.isa || compile.listing_isa;

  $('compiled-opt').textContent = `(${compile.opt || '-O2'})`;
  $('brand-sub').textContent =
    `C \u2192 Assembly (${front.frontend.kind === 'compiler' ? 'Clang ' : ''}`
    + `${compile.opt || '-O2'}${isa ? `, ${isa}` : ''})`;

  const count = stats.available ? stats.instructions
                                : (front.reference_ops || {}).mean;
  $('compiled-sub').textContent = count == null ? '— instructions'
    : `${count} instructions`;
  $('compiled-isa').textContent = isa || front.frontend.kind;
  $('compiled-engine').textContent = front.frontend.title || '';
  $('clang-listing').innerHTML = state.clangAssembly
    ? renderListing(state.clangAssembly, front.function.name)
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
  $('qm-sub').textContent =
    `${target.work} instruction${target.work === 1 ? '' : 's'}`
    + `  |  ${result.residual_freedom} solution${result.residual_freedom === 1 ? '' : 's'}`
    + (verdict ? `  |  ${verdict}` : '');
}

function fillTargets(result) {
  const select = $('sel-isa-view');
  select.innerHTML = (result.targets || []).map((t) => {
    const label = t.ok ? `${t.name} \u00b7 ${t.work} op${t.work === 1 ? '' : 's'}`
                       : `${t.name} \u00b7 —`;
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

function showExamples() {
  openDialog('Examples', EXAMPLES.map((ex, i) =>
    `<button class="btn ex" data-i="${i}">${escapeHtml(ex.name)}`
    + ` <span>— ${escapeHtml(ex.note)}</span></button>`).join(''));
  $('dlg-body').querySelectorAll('.ex').forEach((el) => {
    el.addEventListener('click', () => {
      setSource(EXAMPLES[Number(el.dataset.i)].code);
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

  openDialog(result.frontend.function.signature || 'Details', `
    <table>${rows}</table>
    <h4>Targets</h4><table>${targets}</table>
    ${recognized
      ? `<h4>Recognized</h4><table><tr><th>primitive</th>`
        + `<td>${escapeHtml(recognized)}</td></tr></table>`
      : ''}
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

  const v = capabilities.versions;
  $('lang-note').textContent = `C (${v.qm})`;
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

function init() {
  const fragment = new URLSearchParams(location.hash.slice(1)).get('src');
  let initial = localStorage.getItem('qm.source') || EXAMPLES[0].code;
  if (fragment) {
    try {
      initial = decodeURIComponent(escape(atob(fragment)));
    } catch {
      /* a malformed link should not stop the editor coming up */
    }
  }
  setSource(initial);

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
    if ((event.metaKey || event.ctrlKey) && event.shiftKey
        && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copyOutput();
    }
  });

  $('btn-optimize').addEventListener('click', optimize);
  $('btn-examples').addEventListener('click', showExamples);
  $('btn-copy').addEventListener('click', copyOutput);
  $('btn-details').addEventListener('click', showDetails);
  $('btn-settings').addEventListener('click', () => $('settings').showModal());
  $('settings-close').addEventListener('click', () => $('settings').close());
  $('dlg-close').addEventListener('click', () => $('dlg').close());
  $('sel-observer').addEventListener('change', (event) => {
    $('inp-mask').disabled = event.target.value !== 'mask:custom';
  });
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

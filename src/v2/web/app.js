// Two panes: write C on the left, take the assembly from the right.
//
// Everything the pipeline reports is still available, but nothing explains
// itself at you. The status bar carries the few numbers worth a glance, and
// clicking it opens the full derivation for anyone who wants it.

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

function highlightAsm(text) {
  return escapeHtml(text)
    .split('\n')
    .map((line) => {
      const comment = line.match(/([#;].*)$/);
      let body = comment ? line.slice(0, line.length - comment[1].length) : line;
      const tail = comment ? `<span class="tok-com">${comment[1]}</span>` : '';

      if (/^\s*\./.test(body)) {
        body = body.replace(/^(\s*)(\.[\w.]+)/, '$1<span class="tok-dir">$2</span>');
      } else if (/^[\w.$]+:/.test(body)) {
        body = body.replace(/^([\w.$]+)(:)/, '<span class="tok-label">$1</span>$2');
      } else {
        body = body
          .replace(/^(\s+)([a-z][\w.]*)/, '$1<span class="tok-kw">$2</span>')
          .replace(/(%[a-z0-9]+)/g, '<span class="tok-reg">$1</span>')
          .replace(/(\$?0[xX][0-9a-fA-F]+|\$\d+)/g, '<span class="tok-num">$1</span>');
      }
      return body + tail;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function gutterFor(text, minimum) {
  const n = Math.max(text.split('\n').length, minimum || 1);
  return Array.from({ length: n }, (_, i) => i + 1).join('\n');
}

function syncSource() {
  const code = $('source').value;
  $('highlight').innerHTML = highlightC(code) + '\n';
  $('gutter').textContent = gutterFor(code, 20);
  localStorage.setItem('qm.source', code);
  $('dirty-dot').classList.add('is-dirty');
}

function setSource(code) {
  $('source').value = code;
  syncSource();
}

function showOutput(text, kind) {
  const box = $('out-code');
  if (!text) {
    box.innerHTML = '<span class="hint-line">nothing here yet</span>';
    $('out-gutter').textContent = '';
    return;
  }
  box.innerHTML = (kind === 'c' ? highlightC(text) : highlightAsm(text)) + '\n';
  $('out-gutter').textContent = gutterFor(text, 1);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function currentTarget() {
  if (!state.result || !state.result.ok) return null;
  const targets = state.result.targets || [];
  return targets.find((t) => t.name === state.isa && t.ok)
    || targets.find((t) => t.name === state.result.primary_target)
    || targets.find((t) => t.ok)
    || null;
}

function viewText() {
  const target = currentTarget();
  if (state.view === 'clang') {
    return { text: state.clangAssembly, kind: 'asm', name: 'clang.s' };
  }
  if (!target) return { text: '', kind: 'asm', name: 'kernel_qm.s' };
  if (state.view === 'c') {
    return { text: target.c || '', kind: 'c', name: 'kernel_qm.c' };
  }
  if (!target.asm) {
    // Some lowerings (a lookup table, a software gather loop) have no short
    // assembly form in the emitter.  Hand over the C rather than nothing.
    return {
      text: `/* no assembly form for ${(target.instructions || []).join(' ')} */\n\n`
            + (target.c || ''),
      kind: 'c',
      name: 'kernel_qm.c',
    };
  }
  return { text: target.asm, kind: 'asm', name: 'kernel_qm.s' };
}

function renderView() {
  const { text, kind } = viewText();
  showOutput(text, kind);
  document.querySelectorAll('#pane-output .tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === state.view);
  });
  const clangTab = document.querySelector('#pane-output .tab[data-view="clang"]');
  if (clangTab) clangTab.disabled = !state.clangAssembly;
}

function fillTargets(result) {
  const select = $('sel-isa-view');
  select.innerHTML = (result.targets || []).map((t) => {
    const label = t.ok ? `${t.name} · ${t.work} op${t.work === 1 ? '' : 's'}`
                       : `${t.name} · —`;
    return `<option value="${t.name}"${t.ok ? '' : ' disabled'}>${escapeHtml(label)}</option>`;
  }).join('');
  state.isa = result.primary_target;
  select.value = state.isa;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function seg(id, text, cls) {
  const el = $(id);
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = text;
  el.className = `seg click${cls ? ` ${cls}` : ''}`;
}

function status(text) { $('st-state').textContent = text; }

function renderStatus(result) {
  if (!result || !result.ok) {
    status('error');
    ['st-verify', 'st-before', 'st-freedom'].forEach((id) => seg(id, '', null));
    return;
  }

  const target = currentTarget();
  const v = target && target.verification;
  const before = (result.frontend.reference_ops || {}).mean;

  status(result.frontend.function.name || 'done');

  if (v) {
    seg('st-verify',
        `${v.pass ? '✓' : '✗'} ${v.matched.toLocaleString()}/${v.total.toLocaleString()}`
          + (v.exhaustive ? '' : ' sampled'),
        v.pass ? (v.exhaustive ? 'pass' : 'warn') : 'fail');
  } else {
    seg('st-verify', '', null);
  }

  if (target && before != null) {
    seg('st-before', `${before} → ${target.work}`, null);
  } else if (target) {
    seg('st-before', `${target.work} ops`, null);
  } else {
    seg('st-before', '', null);
  }

  seg('st-freedom',
      `${result.residual_freedom} solution${result.residual_freedom === 1 ? '' : 's'}`,
      result.residual_freedom === 0 ? 'warn' : null);
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
  status('compiling…');
  state.worker.postMessage({ type: 'solve', source, options: currentOptions() });
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
  const { text } = viewText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('copied');
  } catch {
    toast('clipboard unavailable', true);
  }
}

function downloadOutput() {
  const { text, name } = viewText();
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
  $('st-engine').textContent = `qm ${v.qm} · ${v.grammar}/${v.objective}`;
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
      : `Clang/WASM loads on the first Optimize. Listing: ${msg.clang.listing}.`;
    status('ready');
    $('btn-optimize').disabled = false;
    return;
  }

  if (msg.type === 'compile-error') {
    state.clangAssembly = '';
    showOutput(msg.stderr, 'asm');
    return;
  }

  if (msg.type === 'done') {
    state.busy = false;
    $('btn-optimize').disabled = false;
    state.result = msg.result;
    $('dirty-dot').classList.remove('is-dirty');

    if (!msg.result.ok) {
      state.clangAssembly = '';
      renderStatus(msg.result);
      showOutput(msg.result.error.text || msg.result.error.message, 'asm');
      toast(msg.result.error.message, true);
      return;
    }

    state.clangAssembly = (msg.result.compiled && msg.result.compiled.assembly) || '';
    $('chip-signature').textContent = msg.result.frontend.function.signature || '';
    fillTargets(msg.result);
    if (state.view === 'clang' && !state.clangAssembly) state.view = 'asm';
    renderView();
    renderStatus(msg.result);
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
// Split drag
// ---------------------------------------------------------------------------

function wireDrag() {
  const bar = $('dragbar');
  const split = $('split');
  let dragging = false;

  bar.addEventListener('pointerdown', (event) => {
    dragging = true;
    bar.setPointerCapture(event.pointerId);
    document.body.style.userSelect = 'none';
  });

  bar.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    if (window.matchMedia('(max-width: 900px)').matches) {
      const ratio = (event.clientY - rect.top) / rect.height;
      const clamped = Math.min(0.85, Math.max(0.15, ratio));
      split.style.gridTemplateRows = `${clamped}fr 6px ${1 - clamped}fr`;
    } else {
      const ratio = (event.clientX - rect.left) / rect.width;
      const clamped = Math.min(0.85, Math.max(0.15, ratio));
      split.style.gridTemplateColumns = `${clamped}fr 6px ${1 - clamped}fr`;
    }
  });

  const stop = () => {
    dragging = false;
    document.body.style.userSelect = '';
  };
  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);
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
  $('dirty-dot').classList.remove('is-dirty');

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

  $('out-code').addEventListener('scroll', () => {
    $('out-gutter').scrollTop = $('out-code').scrollTop;
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
  $('btn-download').addEventListener('click', downloadOutput);
  $('btn-settings').addEventListener('click', () => $('settings').showModal());
  $('settings-close').addEventListener('click', () => $('settings').close());
  $('dlg-close').addEventListener('click', () => $('dlg').close());
  $('statusbar').addEventListener('click', showDetails);
  $('sel-observer').addEventListener('change', (event) => {
    $('inp-mask').disabled = event.target.value !== 'mask:custom';
  });
  $('sel-isa-view').addEventListener('change', (event) => {
    state.isa = event.target.value;
    renderView();
    renderStatus(state.result);
  });
  document.querySelectorAll('#pane-output .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      state.view = tab.dataset.view;
      renderView();
    });
  });

  wireDrag();

  state.worker = new Worker(new URL('worker.js', import.meta.url),
                            { type: 'module' });
  state.worker.addEventListener('message', onMessage);
  state.worker.postMessage({
    type: 'boot',
    search: location.search,
    config: readConfig(location.search),
  });
  status('booting…');
}

init();

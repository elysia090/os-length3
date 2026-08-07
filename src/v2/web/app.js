// UI shell.  All computation happens in the worker; this file only renders.

import { readConfig } from './clang.js';

const $ = (id) => document.getElementById(id);

const EXAMPLES = [
  {
    name: 'ranks8 — exclusive prefix counts',
    note: 'SPEC §1. 502 solutions remain tied.',
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
    name: 'inclusive_rank8 — uniquely forced',
    note: 'The boundary condition removes all freedom: 1 solution.',
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
    name: 'quote_state_before8 — running parity',
    note: 'Normalizes to CONV(CLMUL): a carry-less convolution.',
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
    name: 'select8 — compaction indices',
    note: 'Needs a data-dependent permutation: PERM_DYN.',
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
    name: 'run_ids8 — POINT then convolution',
    note: 'A lane-local step before the linear map: 4 core ops.',
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
    name: 'morton_dilate16 — pure LIN_CONST',
    note: 'A constant GF(2)-linear map; the representative is what varies.',
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

const STEPS = ['paste', 'compile', 'observe', 'quotients', 'normalize',
               'synthesize', 'verify', 'results'];

const state = {
  worker: null,
  ready: false,
  busy: false,
  capabilities: null,
  clang: null,
  result: null,
  assembly: '',
};

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const C_TYPES = /\b(uint(8|16|32|64)_t|int(8|16|32|64)_t|unsigned|signed|void|char|short|int|long|float|double|bool|_Bool|size_t)\b/g;
const C_KEYWORDS = /\b(for|while|do|if|else|return|break|continue|switch|case|default|static|inline|const|sizeof|struct|typedef|goto|extern|volatile|register)\b/g;

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function highlight(code) {
  // Comments, strings and preprocessor lines are lifted out first, because the
  // token passes below rewrite digits and would otherwise corrupt them.  The
  // placeholder uses a control character precisely so that no later pass can
  // match it.
  const guarded = [];
  // The index is wrapped in letters so the digit pass below sees no word
  // boundary and leaves the placeholder alone.
  const hold = (html) => `\u0001g${guarded.push(html) - 1}z\u0001`;

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

  return out.replace(/\u0001g(\d+)z\u0001/g, (_, i) => guarded[Number(i)]);
}


function syncEditor() {
  const code = $('source').value;
  const lines = code.split('\n');
  const shown = Math.max(lines.length, 14);
  $('highlight').innerHTML = highlight(code) + '\n';
  $('gutter').textContent = Array.from({ length: shown }, (_, i) => i + 1).join('\n');
  $('line-count').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
  localStorage.setItem('qm.source', code);
}

function setSource(code) {
  $('source').value = code;
  syncEditor();
  setStep('paste');
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function setStep(name) {
  const index = STEPS.indexOf(name);
  document.querySelectorAll('.step').forEach((el, i) => {
    el.classList.toggle('is-active', i === index);
    el.classList.toggle('is-done', i < index);
  });
}

let toastTimer = null;
function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2600);
}

function status(text) { $('foot-status').textContent = text; }

function openDialog(title, html) {
  $('dlg-title').textContent = title;
  $('dlg-body').innerHTML = html;
  $('dlg').showModal();
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    toast('clipboard unavailable', true);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAssembly(text) {
  state.assembly = text || '';
  const box = $('asm-listing');
  if (!text) {
    box.innerHTML = '<p class="placeholder">The compiler produced no assembly listing.</p>';
    return;
  }

  const rows = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('.file') || trimmed.startsWith('.ident')) continue;
    if (/^[.\w$]+:$/.test(trimmed)) {
      rows.push(`<div class="row"><span class="addr"></span><span class="label">${escapeHtml(trimmed)}</span></div>`);
      continue;
    }
    if (trimmed.startsWith('.')) continue;
    const m = trimmed.match(/^([a-z][a-z0-9._]*)\s*(.*)$/);
    if (!m) continue;
    const addr = offset.toString(16).toUpperCase().padStart(4, '0');
    offset += 4;
    rows.push(
      `<div class="row"><span class="addr">${addr}</span>` +
      `<span class="mn">${escapeHtml(m[1])}</span>` +
      `<span class="ops">${escapeHtml(m[2])}</span></div>`,
    );
    if (rows.length > 400) { rows.push('<div class="row more">…</div>'); break; }
  }
  box.innerHTML = rows.join('') || '<p class="placeholder">Nothing to disassemble.</p>';
}

function renderCompiledInfo(result) {
  const front = result.frontend || {};
  const stats = front.assembly_stats || {};
  const sub = front.compile || {};
  $('compiled-sub').textContent = front.frontend && front.frontend.kind === 'compiler'
    ? `(Clang ${sub.opt || '-O2'}, ${sub.target || 'x86-64'})`
    : `(${(front.frontend && front.frontend.title) || 'built-in frontend'})`;

  const count = stats.available ? stats.instructions : (front.reference_ops || {}).mean;
  $('asm-instructions').textContent =
    count === undefined || count === null ? '— instructions' : `${count} instructions`;
  $('asm-bytes').textContent = state.assembly
    ? `${new Blob([state.assembly]).size} bytes of asm`
    : '— bytes';

  const info = $('asm-info');
  const mnemonics = stats.available ? stats.distinct_mnemonics : '—';
  const rows = [
    ['Functions', (front.functions_in_source || []).length || 1],
    ['Distinct mnemonics', mnemonics],
    ['Input domain', `2^${result.semantics.input_bits}`],
    ['Verification', result.semantics.domain.strength],
  ];
  info.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function renderMetrics(result, primary) {
  const program = result.program || {};
  const pass = primary && primary.verification && primary.verification.pass;
  $('m-core').textContent = program.core_ops ?? '—';
  $('m-span').textContent = primary ? primary.span : '—';
  $('m-work').textContent = primary ? primary.work : '—';
  $('m-freedom').textContent = result.residual_freedom ?? '—';
  $('m-status').textContent = pass ? 'PASS' : (result.program ? 'CHECK' : 'NONE');
  $('m-status-sub').textContent = primary && primary.verification
    ? (primary.verification.exhaustive ? 'exact' : 'sampled') : ' ';

  const card = $('m-status').closest('.metric');
  card.classList.toggle('pass', Boolean(pass));
  card.classList.toggle('fail', Boolean(result.program) && !pass);

  const badge = $('verified-badge');
  badge.hidden = !result.program;
  badge.classList.toggle('fail', Boolean(result.program) && !pass);
  badge.lastChild.textContent = pass ? ' Verified' : ' Unverified';
}

function renderVerification(result, primary) {
  const pane = $('pane-verify');
  const v = primary && primary.verification;
  if (!v) {
    pane.classList.add('fail');
    $('v-mode').textContent = 'No program to verify';
    $('v-count').textContent = '—';
    $('v-pct').textContent = ' ';
    $('v-pill').hidden = true;
    return;
  }
  const pct = v.total ? (100 * v.matched / v.total) : 0;
  pane.classList.toggle('fail', !v.pass);
  $('v-mode').textContent = v.mode.charAt(0).toUpperCase() + v.mode.slice(1);
  $('v-count').textContent = `${v.matched.toLocaleString()} / ${v.total.toLocaleString()} inputs`;
  $('v-pct').textContent = `(${pct.toFixed(2)}%)`;
  const pill = $('v-pill');
  pill.hidden = false;
  pill.textContent = v.pass ? 'PASS' : 'FAIL';
  pill.classList.toggle('fail', !v.pass);
  pane.title = v.claim;
}

function renderObserver(result) {
  const obs = result.observer || {};
  const report = (result.quotients || {}).observation || {};
  $('obs-kind').textContent = obs.kind === 'exact' ? '(default)' : `(${obs.spec})`;
  $('obs-formula').textContent = obs.kind === 'exact'
    ? `obs(y) = y (${result.semantics.output_bits}-bit)`
    : `obs(y) = y & ${obs.mask || obs.spec}`;
  $('obs-note').textContent = report.is_identity_on_domain
    ? 'All output bits are significant.'
    : `${report.distinct_outputs} distinct outputs collapse to ${report.distinct_observables}.`;
}

function renderProgram(result, primary) {
  const list = $('program');
  $('canon-isa').textContent = primary ? `(${primary.isa.title})` : '';
  if (!primary || !primary.ok) {
    list.innerHTML = `<li class="placeholder-row">${
      result.note || 'No program in the declared grammar for this observer.'}</li>`;
    return;
  }

  const reps = primary.representatives || [];
  const rows = primary.instructions.map((mnemonic, i) => {
    const detail = (result.program.ops[Math.min(i, result.program.ops.length - 1)] || {});
    const rep = reps[Math.min(i, reps.length - 1)];
    const why = rep ? `${rep[0]} → ${rep[1]}` : (detail.label || '');
    const constants = Object.entries(detail.detail || {})
      .filter(([k, v]) => typeof v === 'string' && v.startsWith('0x'))
      .map(([, v]) => v);
    const side = i === 0
      ? `<b>${primary.span}</b>span`
      : (i === 1 ? `<b>${primary.work}</b>work` : '');
    return `<li>
      <span class="idx">${i + 1}</span>
      <span class="op">${escapeHtml(mnemonic)}</span>
      <span class="args">${escapeHtml(constants.join(', ') || '—')}
        <span class="why">${escapeHtml(why)}</span></span>
      <span class="side">${side}</span>
    </li>`;
  });
  list.innerHTML = rows.join('');
}

function renderAlternatives(result) {
  const box = $('alts');
  const targets = result.targets || [];
  $('alt-title').textContent = `Alternative Lowerings (${targets.length} targets)`;
  if (!targets.length) { box.innerHTML = ''; return; }

  const best = Math.min(...targets.filter((t) => t.ok).map((t) => t.work), Infinity);
  box.innerHTML = targets.map((t) => {
    if (!t.ok) {
      return `<button class="alt is-dead" data-isa="${t.name}">
        <span class="name">${escapeHtml(t.isa.title)}</span>
        <span class="sub">cannot lower</span>
        <span class="bars">${'<span style="height:3px"></span>'.repeat(8)}</span>
      </button>`;
    }
    const max = Math.max(...targets.filter((x) => x.ok).map((x) => x.work), 1);
    const bars = Array.from({ length: 8 }, (_, i) => {
      const h = i < t.work ? Math.max(6, 42 - i * (30 / Math.max(max, 4))) : 3;
      return `<span style="height:${h.toFixed(0)}px"></span>`;
    }).join('');
    return `<button class="alt${t.work === best ? ' is-best' : ''}" data-isa="${t.name}">
      <span class="name">${escapeHtml(t.isa.title)}</span>
      <span class="sub">${t.work} core op${t.work === 1 ? '' : 's'}</span>
      <span class="bars">${bars}</span>
    </button>`;
  }).join('');

  box.querySelectorAll('.alt').forEach((el) => {
    el.addEventListener('click', () => showTarget(el.dataset.isa));
  });
}

function showTarget(name) {
  const t = (state.result.targets || []).find((x) => x.name === name);
  if (!t) return;
  if (!t.ok) {
    openDialog(t.isa.title, `<p>${escapeHtml(t.reason || 'cannot lower')}</p>`);
    return;
  }
  openDialog(t.isa.title, `
    <table>
      <tr><th>Instructions</th><td>${escapeHtml(t.instructions.join(' '))}</td></tr>
      <tr><th>Span / Work</th><td>${t.span} / ${t.work}</td></tr>
      <tr><th>Description length</th><td>${t.L_bits} bits (${t.L_bytes} bytes)</td></tr>
      <tr><th>Representatives</th><td>${t.representatives.map((r) => escapeHtml(`${r[0]} → ${r[1]}`)).join('<br>')}</td></tr>
      <tr><th>Verification</th><td>${escapeHtml(t.verification.claim)}</td></tr>
    </table>
    <h4>C</h4><pre>${escapeHtml(t.c)}</pre>
    ${t.asm ? `<h4>Assembly</h4><pre>${escapeHtml(t.asm)}</pre>` : ''}
  `);
}

function renderResult(result) {
  state.result = result;

  if (!result.ok) {
    setStep('paste');
    const box = document.createElement('div');
    box.className = 'error-box';
    box.innerHTML = `<strong>${escapeHtml(result.stage || 'error')}:</strong> ` +
      escapeHtml(result.error.message || 'failed') +
      (result.error.hint ? `<br><code>${escapeHtml(result.error.hint)}</code>` : '');
    const card = $('card-result');
    card.querySelectorAll('.error-box').forEach((n) => n.remove());
    card.querySelector('.metrics').before(box);
    renderMetrics(result, null);
    renderVerification(result, null);
    return;
  }

  $('card-result').querySelectorAll('.error-box').forEach((n) => n.remove());

  const primary = (result.targets || []).find((t) => t.name === result.primary_target)
    || (result.targets || []).find((t) => t.ok) || null;

  renderCompiledInfo(result);
  renderMetrics(result, primary);
  renderVerification(result, primary);
  renderObserver(result);
  renderProgram(result, primary);
  renderAlternatives(result);
  setStep('results');

  const v = result.versions || {};
  $('foot-version').textContent = `QM ${v.qm || '—'}`;
  $('foot-grammar').textContent = `Grammar: ${v.grammar || '—'}`;
  $('foot-solver').textContent = `Solver: ${v.solver || '—'}`;
  $('foot-corpus').textContent = result.corpus && result.corpus.canonical
    ? `Corpus key: ${result.corpus.semantic_key.slice(0, 10)}…`
    : 'Corpus: not canonical';
  status(`done in ${result.elapsed_s ?? '?'}s`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function currentOptions() {
  const isaSelect = $('sel-isa');
  const targets = Array.from(isaSelect.selectedOptions).map((o) => o.value);
  const observer = $('sel-observer').value === 'mask:custom'
    ? `mask:${$('inp-mask').value || '0xFFFFFFFFFFFFFFFF'}`
    : $('sel-observer').value;
  return {
    frontend: $('sel-compiler').value,
    opt: $('sel-opt').value,
    source_target: $('sel-target').value,
    observer,
    targets: targets.length ? targets : undefined,
  };
}

function optimize() {
  if (!state.ready || state.busy) return;
  const source = $('source').value.trim();
  if (!source) { toast('paste a C function first', true); return; }

  state.busy = true;
  $('btn-optimize').disabled = true;
  setStep('compile');
  status('working…');
  state.worker.postMessage({ type: 'solve', source, options: currentOptions() });
}

function shareSource() {
  // SPEC §1: Share Source is explicit and opt-in.  The link carries the source
  // in the fragment, which browsers do not send to any server.
  const encoded = btoa(unescape(encodeURIComponent($('source').value)));
  const url = `${location.origin}${location.pathname}#src=${encoded}`;
  copy(url, 'Share link');
  openDialog('Share Source', `
    <p>This link carries your source in the URL fragment. Fragments are not sent
    to the server, but anyone you send the link to can read the code.</p>
    <pre>${escapeHtml(url)}</pre>`);
}

function exportResult() {
  if (!state.result || !state.result.ok) { toast('nothing to export', true); return; }
  const primary = (state.result.targets || []).find((t) => t.ok);
  const files = {
    'qm-result.json': JSON.stringify(state.result, null, 2),
    'qm-kernel.c': primary ? primary.c : '',
    'qm-kernel.s': primary && primary.asm ? primary.asm : '',
    'qm-verification.txt': verificationReport(state.result, primary),
  };
  const links = Object.entries(files)
    .filter(([, body]) => body)
    .map(([name, body]) => {
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      return `<a class="btn ex" download="${name}" href="${url}">${name}</a>`;
    })
    .join('');
  openDialog('Export', `<p>Everything is produced in your browser.</p>${links}`);
}

function verificationReport(result, primary) {
  const lines = [
    'Quotient Minimizer verification report',
    `qm ${result.versions.qm} / grammar ${result.versions.grammar} / objective ${result.versions.objective}`,
    '',
    `function          ${result.frontend.function.signature}`,
    `frontend          ${result.frontend.frontend.title}`,
    `observer          ${result.observer.description}`,
    `domain            2^${result.semantics.input_bits} (${result.semantics.domain.kind})`,
    `residual freedom  ${result.residual_freedom}`,
    '',
  ];
  for (const t of result.targets || []) {
    if (!t.ok) { lines.push(`${t.name.padEnd(20)} cannot lower: ${t.reason}`); continue; }
    lines.push(`${t.name.padEnd(20)} ${t.instructions.join(' ')}`);
    lines.push(`${''.padEnd(20)} ${t.verification.mode} ${t.verification.matched}/${t.verification.total} ${t.verification.pass ? 'PASS' : 'FAIL'}`);
  }
  lines.push('', result.targets.length && primary ? primary.verification.claim : '');
  return lines.join('\n');
}

function showDerivation() {
  if (!state.result || !state.result.ok) { toast('run Optimize first', true); return; }
  const rows = (state.result.derivation || [])
    .map((d) => `<tr><th>${escapeHtml(d.step)}</th><td>${escapeHtml(d.value)}</td></tr>`)
    .join('');
  const guards = (state.result.normalization || {}).guard_evidence || [];
  const evidence = guards.map((g) =>
    `<tr><th>${escapeHtml(g.claim)}</th><td>${g.measured ? 'holds' : 'fails'} — ${escapeHtml(g.implication)}</td></tr>`).join('');
  const quotient = (state.result.quotients || {}).future || {};
  openDialog('Derivation', `
    <table>${rows}</table>
    <h4>Future quotient</h4>
    <p>${escapeHtml(quotient.computed
      ? `${quotient.peak_classes} classes at the peak (${quotient.state_bits} bits of streaming state against ${quotient.naive_state_bits} bits of raw history).`
      : quotient.reason || 'not computed')}</p>
    <h4>Guard evidence</h4><table>${evidence}</table>
    ${state.result.recognition && state.result.recognition.length
      ? `<h4>Recognized as</h4><p>${escapeHtml(state.result.recognition.join(', '))}</p>` : ''}
  `);
}

function showBenchmark() {
  if (!state.result || !state.result.ok) { toast('run Optimize first', true); return; }
  const cost = state.result.cost_model || {};
  const rows = (cost.rows || []).map((r) =>
    `<tr><th>${escapeHtml(r.target)}</th><td>span ${r.span} · work ${r.work} · ${r.instructions} instructions · ${r.code_bits} code bits</td></tr>`).join('');
  openDialog('Benchmark', `
    <p><strong>Compiler baseline:</strong> ${cost.frontend_reference_ops ?? '—'} instructions.</p>
    <table>${rows}</table>
    <p class="muted small">${escapeHtml(cost.note || '')}</p>`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function fillSelects(capabilities) {
  const compiler = $('sel-compiler');
  compiler.innerHTML = capabilities.frontends
    .filter((f) => f.name !== 'precompiled')
    .map((f) => `<option value="${f.name}"${f.name === 'clang' ? ' selected' : ''}>${
      f.name === 'clang' ? 'Clang (WASM)' : escapeHtml(f.title)}</option>`)
    .join('');

  $('sel-observer').innerHTML = capabilities.observers
    .map((o) => `<option value="${o.spec}">${escapeHtml(o.label)}</option>`)
    .join('') + '<option value="mask:custom">Custom bit mask…</option>';

  $('sel-isa').innerHTML = capabilities.targets
    .map((t, i) => `<option value="${t.name}"${i < 4 ? ' selected' : ''}>${escapeHtml(t.title)}</option>`)
    .join('');

  const v = capabilities.versions;
  $('foot-version').textContent = `QM ${v.qm}`;
  $('foot-grammar').textContent = `Grammar: ${v.grammar}`;
  $('foot-solver').textContent = `Solver: ${v.solver}`;
}

function onMessage(event) {
  const msg = event.data;
  if (msg.type === 'progress') { status(msg.message); return; }
  if (msg.type === 'notice') { toast(msg.message, true); return; }

  if (msg.type === 'ready') {
    state.ready = true;
    state.capabilities = msg.capabilities;
    state.clang = msg.clang;
    fillSelects(msg.capabilities);
    $('engine-note').textContent = msg.clang.available
      ? `Engine ready · Clang/WASM configured`
      : `Engine ready · Clang/WASM not configured (${msg.clang.reason || 'no bundle URL'}); ` +
        `the built-in C subset frontend will be used`;
    status('ready');
    $('btn-optimize').disabled = false;
    return;
  }

  if (msg.type === 'done') {
    state.busy = false;
    $('btn-optimize').disabled = false;
    if (msg.result.compiled) renderAssembly(msg.result.compiled.assembly);
    else renderAssembly('');
    renderResult(msg.result);
    return;
  }

  if (msg.type === 'compile-error') {
    renderAssembly('');
    $('asm-listing').innerHTML = `<pre class="placeholder">${escapeHtml(msg.stderr)}</pre>`;
    return;
  }

  if (msg.type === 'fatal') {
    state.busy = false;
    $('btn-optimize').disabled = false;
    status('failed');
    toast(msg.message, true);
  }
}

function init() {
  const stored = localStorage.getItem('qm.source');
  const fragment = new URLSearchParams(location.hash.slice(1)).get('src');
  if (fragment) {
    try { setSource(decodeURIComponent(escape(atob(fragment)))); }
    catch { setSource(EXAMPLES[0].code); }
  } else {
    setSource(stored || EXAMPLES[0].code);
  }

  $('source').addEventListener('input', syncEditor);
  $('source').addEventListener('scroll', () => {
    $('highlight').scrollTop = $('source').scrollTop;
    $('highlight').scrollLeft = $('source').scrollLeft;
    $('gutter').scrollTop = $('source').scrollTop;
  });
  $('source').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const at = el.selectionStart;
      el.value = `${el.value.slice(0, at)}    ${el.value.slice(el.selectionEnd)}`;
      el.selectionStart = el.selectionEnd = at + 4;
      syncEditor();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); optimize(); }
  });

  $('btn-optimize').addEventListener('click', optimize);
  $('btn-optimize').disabled = true;
  $('btn-example').addEventListener('click', () => showExamples());
  $('btn-examples').addEventListener('click', () => showExamples());
  $('btn-docs').addEventListener('click', showDerivation);
  $('btn-settings').addEventListener('click', () => {
    document.querySelectorAll('.panel').forEach((p) => { p.open = true; });
    $('sel-observer').focus();
  });
  $('btn-edit-observer').addEventListener('click', () => {
    document.querySelectorAll('.panel')[1].open = true;
    $('sel-observer').focus();
  });
  $('btn-copy-asm').addEventListener('click', () => copy(state.assembly, 'Assembly'));
  $('btn-copy-result').addEventListener('click', () =>
    copy(JSON.stringify(state.result, null, 2), 'Result JSON'));
  $('btn-copy-program').addEventListener('click', () => {
    const t = (state.result && state.result.targets || []).find((x) => x.ok);
    copy(t ? t.c : '', 'Program');
  });
  $('btn-share').addEventListener('click', shareSource);
  $('btn-export').addEventListener('click', exportResult);
  $('btn-benchmark').addEventListener('click', showBenchmark);
  $('dlg-close').addEventListener('click', () => $('dlg').close());
  $('sel-observer').addEventListener('change', (e) => {
    $('inp-mask').disabled = e.target.value !== 'mask:custom';
  });

  // Resolved against this module, not the document: index.html is also served
  // from the site root, where a document-relative path would miss.
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

function showExamples() {
  const html = EXAMPLES.map((ex, i) =>
    `<button class="btn ex" data-i="${i}"><strong>${escapeHtml(ex.name)}</strong><br>
     <span class="muted small">${escapeHtml(ex.note)}</span></button>`).join('');
  openDialog('Examples', html);
  $('dlg-body').querySelectorAll('.ex').forEach((el) => {
    el.addEventListener('click', () => {
      setSource(EXAMPLES[Number(el.dataset.i)].code);
      $('dlg').close();
    });
  });
}

init();

import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {t} from '../../../text/i18n.ts';
import {onChange, store} from '../../../repo/repos.ts';
import {shownPath} from '../../../repo/issues.ts';
import {stillAt} from '../../../repo/search.ts';
import {foundView, patched, readAll, search, type Files} from './found.ts';

interface Ways {
  scope(repo: string | null): string[];
  back(): void;
  write(query: string): void;
  open(repo: string, path: string, line: number): void;
}

/** One repo's search, in its own place. The result rows use the same source and matcher as Home's Reference. */
export function searchScreen(repo: string | null, query: string, opened: string[], ways: Ways) {
  const sayScope = () => t(repo ? 'Search this repo' : 'No repo to search');
  const nameScope = () => t(repo ? 'Search this repo' : 'Search');
  const input = h('input', {class: 'search-in', type: 'search', 'aria-label': nameScope(),
    'aria-controls': 'repo-search-results', placeholder: sayScope(), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
  input.value = query;
  const back = h('button', {class: 'search-screen-back', type: 'button'}, h('span', {'aria-hidden': 'true'}, '←'), t('Back'));
  back.addEventListener('click', ways.back);
  const scope = h('select', {class: 'search-screen-repo', 'aria-label': t('Search in')}) as HTMLSelectElement;
  scope.hidden = !repo;
  if (repo) scope.append(new Option(repo, repo));
  const form = h('form', {role: 'search', class: 'search-screen-form'}, mark('search'), input);
  const rows = h('div', {class: 'search-screen-matches'});
  const status = h('p', {class: 'search-screen-status', role: 'status'});
  const results = h('section', {class: 'search-screen-results', id: 'repo-search-results', 'aria-label': t('Search results')}, rows, status);
  const paper = h('div', {class: 'search-screen-paper'}, form, results);
  const element = h('main', {class: 'search-screen', 'aria-labelledby': 'repo-search-title'},
    h('div', {class: 'search-screen-keys'}, back, scope),
    h('div', {class: 'search-screen-content'},
      h('header', {class: 'search-screen-head'}, h('h1', {id: 'repo-search-title'}, t('Search'))),
      paper));
  let files: Promise<Files> | null = null;
  let revision = 0, frame = 0, gone = false;
  let suggesting: false | 'list' | 'first' = false;
  const choices = () => Array.from(rows.querySelectorAll<HTMLButtonElement>('.choice'));
  const fresh = (run: number) => !gone && run === revision;
  async function go(repo: string, path: string, line: number, words: string, run: number) {
    if (!fresh(run)) return;
    const file = await store.read(repo, path).catch(() => null);
    if (!fresh(run)) return;
    const at = !file ? null : !line ? 0 : file.text == null ? null : stillAt(file.text, words, line);
    if (at === null) {
      opened = opened.filter(other => other !== path);
      files = null; again(); input.focus({preventScroll: true}); return;
    }
    ways.open(repo, path, at);
  }
  async function find(repo: string, words: string, run: number) {
    const batch = files ??= readAll(repo);
    try {
      const ready = await batch;
      if (!fresh(run)) return;
      const found = await search(words, ready, () => !fresh(run));
      if (!found || !fresh(run)) return;
      const open = (path: string, line: number) => { void go(repo, path, line, words, run); };
      const matches = foundView(found, words, {file: path => open(path, 0), line: open}, {sections: true});
      const had = choices().indexOf(document.activeElement as HTMLButtonElement);
      rows.replaceChildren(...matches);
      const next = choices();
      if (had >= 0) (next[Math.min(had, next.length - 1)] ?? input).focus({preventScroll: true});
      status.textContent = matches.length ? '' : t('No results found for "{query}"', {query: words});
    } catch (error) {
      if (batch === files) files = null;
      if (fresh(run)) status.textContent = t('Search failed: {message}', {message: String(error)});
    } finally {
      if (fresh(run)) results.removeAttribute('aria-busy');
    }
  }
  /** Suggest actual open work first, then existing files at the repo's root if it has not been worked in. */
  async function suggest(repo: string, run: number) {
    const solid = Array.from(new Set(opened)).slice(0, 5);
    if (solid.length < 3) {
      const root = await store.tree(repo, '').catch(() => []);
      const paths = root.filter(entry => entry.kind === 'file').map(entry => entry.name);
      for (const path of paths) if (!solid.includes(path) && solid.length < 5) solid.push(path);
    }
    if (!fresh(run)) return;
    if (!solid.length) { suggesting = false; return; }
    const heading = t('Suggested files');
    const links = solid.map(path => {
      const item = h('button', {type: 'button', class: 'choice search-suggestion'}, shownPath(path));
      item.addEventListener('click', () => void go(repo, path, 0, '', run));
      return item;
    });
    rows.replaceChildren(h('section', {class: 'search-suggestions', 'aria-label': heading},
      h('h2', {class: 'found-sec-head'}, heading), ...links));
    if (suggesting === 'first') {
      suggesting = 'list';
      if (document.activeElement === input) links[0].focus();
    }
  }

  function putAwaySuggestions() {
    if (!suggesting) return false;
    suggesting = false; again();
    return true;
  }

  function again() {
    cancelAnimationFrame(frame);
    const from = repo, words = input.value.trim(), run = ++revision;
    if (!from || !words) {
      status.textContent = from || !words ? '' : t('No repo to search');
      rows.replaceChildren(); results.removeAttribute('aria-busy');
      if (from && suggesting) void suggest(from, run);
      return;
    }
    results.setAttribute('aria-busy', 'true');
    frame = requestAnimationFrame(() => void find(from, words, run));
  }
  const unwatch = onChange(c => {
    if (c.repo !== repo || !input.value.trim()) return;
    if (files) files = patched(files, c);
    again();
  });
  const empty = () => {
    suggesting = false;
    rows.replaceChildren();
    status.textContent = '';
  };
  function lookIn(next: string | null) {
    if (next === repo) return;
    repo = next;
    input.placeholder = sayScope();
    input.setAttribute('aria-label', nameScope());
    scope.hidden = !repo;
    opened = ways.scope(repo); files = null; empty();
    again();
  }
  scope.addEventListener('change', () => {
    if (!scope.value) return;
    lookIn(scope.value);
    // A select closes and returns focus to its key after issuing change. Give the hand back to the query then.
    requestAnimationFrame(() => {
      if (!gone && document.activeElement === scope) input.focus({preventScroll: true});
    });
  });
  input.addEventListener('input', () => {
    empty(); ways.write(input.value); again();
  });
  // Chrome's clear button also clicks the input, but clears its value before that click arrives.
  let pressedEmpty = false;
  input.addEventListener('pointerdown', () => { pressedEmpty = input.value === ''; });
  input.addEventListener('click', (e) => {
    const asked = pressedEmpty || e.detail === 0;
    pressedEmpty = false;
    if (!repo || !asked || input.value.trim() || suggesting) return;
    suggesting = 'list'; again();
  });
  paper.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof Node && paper.contains(e.relatedTarget))) putAwaySuggestions();
  });
  element.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Node && paper.contains(e.target))) putAwaySuggestions();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); choices()[0]?.click(); });
  element.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Escape') {
      // A native scope picker takes its own Escape before Search takes another.
      if (CSS.supports('selector(:open)') && scope.matches(':open')) return;
      e.preventDefault();
      if (putAwaySuggestions()) input.focus({preventScroll: true});
      else ways.back();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'p')) {
      e.preventDefault(); input.focus({preventScroll: true}); input.select(); return;
    }
    const next = choices(), where = next.indexOf(document.activeElement as HTMLButtonElement);
    if (repo && !next.length && e.target === input && e.key === 'ArrowDown' && !input.value.trim()) {
      e.preventDefault();
      const alreadyAsked = !!suggesting;
      suggesting = 'first';
      if (!alreadyAsked) again();
      return;
    }
    if (!next.length || (where < 0 && e.target !== input)) return;
    const to = e.key === 'ArrowDown' ? next[where + 1] : e.key === 'ArrowUp' && where >= 0 ? next[where - 1] ?? input
      : where >= 0 && e.key === 'Home' ? next[0] : where >= 0 && e.key === 'End' ? next.at(-1) : null;
    if (to) { e.preventDefault(); to.focus(); }
  });
  return {
    element,
    focus() {
      input.focus({preventScroll: true}); input.select(); again();
      void store.names().then(names => {
        if (gone) return;
        const current = repo && names.includes(repo) ? repo : names[0] ?? null;
        scope.replaceChildren(...Array.from(new Set(current ? [current, ...names] : []), name => new Option(name, name)));
        scope.value = current ?? '';
        lookIn(current);
      }, () => {});
    },
    close() { gone = true; cancelAnimationFrame(frame); unwatch(); element.remove(); },
  };
}

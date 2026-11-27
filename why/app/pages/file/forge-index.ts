import {errorText} from '../../../api/errors.ts';
import {inRepo, list, type SystemEntry} from '../../../prompt/system.ts';
import {shownName} from '../../../repo/issues.ts';
import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';

type Path = {repo: string; path: string};
type Preview = {path: string; slot: HTMLElement};
type Peer = {entry: SystemEntry; button: HTMLElement; parent: string};
type Events = {
  actions(row: HTMLElement, name: HTMLElement, entry: SystemEntry, path: Path, dir: boolean, disclose: boolean): HTMLButtonElement;
  carry(row: HTMLElement, path: Path, into: (() => void) | null): void;
  open(name: HTMLElement, path: Path): void;
  replace(contents: HTMLElement, back?: HTMLElement): void;
  dismiss(): void;
  say(text: string): void;
};
const below = (path: string, root: string) => path === root || path.startsWith(root + '/');
const note = (text: string) => h('li', {class: 'file-shelf-empty', role: 'treeitem'}, text);

/** The fixed left Files index. The tree still owns operations; this owns the reading order and visible branches. */
export class ForgeFileIndex {
  #generation = 0;
  #stop: (() => void) | undefined;
  #opened = new Set<string>();
  #contents = new Map<string, Set<string>>();
  private readonly root: HTMLElement;
  private readonly events: Events;
  constructor(root: HTMLElement, events: Events) { this.root = root; this.events = events; }

  close() { ++this.#generation; this.#stop?.(); this.#stop = undefined; }
  sees(path: string): boolean {
    const parent = path.slice(0, path.lastIndexOf('/'));
    return this.#contents.has(parent);
  }
  knows(path: string): boolean {
    const parent = path.slice(0, path.lastIndexOf('/'));
    return this.#contents.get(parent)?.has(path) ?? false;
  }
  forget(path: string) {
    for (const open of this.#opened) if (below(open, path)) this.#opened.delete(open);
  }
  moved(repo: string, from: string, to: string, showTarget: boolean) {
    const was = `/root/${repo}/${from}`, now = `/root/${repo}/${to}`;
    for (const path of [...this.#opened]) if (below(path, was)) {
      this.#opened.delete(path); this.#opened.add(now + path.slice(was.length));
    }
    if (showTarget) this.parents(repo, to.slice(0, Math.max(0, to.lastIndexOf('/'))));
  }
  parents(repo: string, path: string) {
    for (let branch = path; branch; branch = branch.slice(0, Math.max(0, branch.lastIndexOf('/'))))
      this.#opened.add(`/root/${repo}/${branch}`);
  }

  async draw(repo: string) {
    this.close();
    const generation = this.#generation, rootPath = `/root/${repo}`;
    const current = () => generation === this.#generation;
    let entries: SystemEntry[];
    try { entries = await list(rootPath); }
    catch (error) {
      if (current()) {
        this.events.replace(this.root);
        this.root.replaceChildren(note(errorText(error)));
      }
      return;
    }
    if (!current()) return;
    const restored = new Map<string, SystemEntry[]>(), contents = new Map<string, Set<string>>();
    const record = (path: string, children: readonly SystemEntry[]) => contents.set(path, new Set(children.map(e => e.path)));
    record(rootPath, entries);
    await Promise.all([...this.#opened].filter(path => below(path, rootPath)).map(async path => {
      try { const children = await list(path); restored.set(path, children); record(path, children); }
      catch { if (current()) this.forget(path); }
    }));
    if (!current()) return;

    this.#contents = contents;
    const title = h('button', {class: 'tree-name file-shelf-title', type: 'button', 'data-path': rootPath, 'data-repo': repo,
      'aria-current': 'page', 'aria-haspopup': 'menu'}, repo);
    const heading = h('div', {class: 'tree-row file-shelf-heading'}, title);
    const rootEntry = {name: repo, kind: 'dir', path: rootPath} satisfies SystemEntry;
    const rootActions = this.events.actions(heading, title, rootEntry, {repo, path: ''}, true, false);
    title.addEventListener('click', () => rootActions.click());
    this.events.carry(heading, {repo, path: ''}, () => {});

    const previews = new WeakMap<Element, Preview>();
    const queue: Preview[] = [];
    const closePreview = new WeakMap<HTMLElement, () => void>();
    const peers = new Map<string, Peer[]>();
    let active = 0, groups = 0;

    const disclosure = (controls: HTMLElement[], host: HTMLElement, path: string, label: string, preview?: HTMLElement) => {
      const owner = controls[0]!;
      const branch = h('ul', {class: 'file-shelf-branch', id: `file-shelf-branch-${generation}-${++groups}`,
        'aria-label': label, role: 'group', hidden: ''});
      host.append(branch);
      for (const button of controls) button.setAttribute('aria-controls', branch.id);
      const mark = (open: boolean) => {
        for (const button of controls) button.setAttribute('aria-expanded', String(open));
        if (preview) host.setAttribute('aria-expanded', String(open));
        if (controls.length > 1) controls[1]!.setAttribute('aria-label', t(open ? 'Close {name}' : 'Open {name}', {name: label}));
      };
      mark(false);
      let token = 0, reading = false;
      const show = (children: readonly SystemEntry[]) => {
        if (preview) {
          this.events.replace(preview, owner);
          closePreview.get(preview)?.();
          preview.hidden = true;
        }
        branch.replaceChildren(...rows(children));
        branch.hidden = false;
        mark(true);
      };
      const close = () => {
        ++token; reading = false;
        this.events.replace(branch, owner);
        branch.hidden = true;
        branch.replaceChildren();
        mark(false);
        this.forget(path);
        if (preview) preview.hidden = false;
      };
      if (!preview) closePreview.set(host, close);
      const previous = restored.get(path);
      if (previous && this.#opened.has(path)) show(previous);
      const open = async () => {
        if (reading || !branch.hidden) return;
        reading = true;
        const asked = ++token;
        try {
          const children = await list(path);
          if (!current() || !owner.isConnected || token !== asked) return;
          this.#opened.add(path);
          record(path, children);
          show(children);
        } catch (error) {
          if (current() && owner.isConnected && token === asked) this.events.say(errorText(error));
        } finally { if (token === asked) reading = false; }
      };
      const toggle = () => {
        this.events.say('');
        this.events.dismiss();
        if (branch.hidden && !reading) void open(); else close();
      };
      for (const name of controls) name.addEventListener('click', toggle);
      return open;
    };

    const rows = (items: readonly SystemEntry[]): HTMLElement[] => {
      const out: HTMLElement[] = [];
      for (const entry of items) {
        const at = inRepo(entry.path);
        if (!at || at.repo !== repo) continue;
        const dir = entry.kind === 'dir', label = dir ? entry.name : shownName(at.path);
        const name = h('button', {class: 'tree-name file-shelf-name', type: 'button', 'data-path': entry.path,
          ...(dir ? {'aria-label': label} : {})}, h('span', {class: 'file-shelf-primary'}, dir ? label + '/' : label));
        const row = h('div', {class: 'tree-row file-shelf-first'}, name);
        const item = h('li', {class: 'file-shelf-row', role: 'treeitem', 'aria-label': label, ...(dir ? {'data-folder': ''} : {})}, row);
        const more = this.events.actions(row, name, entry, at, dir, dir);
        if (dir) {
          const slot = h('div', {class: 'file-shelf-preview-slot'});
          item.append(slot);
          const open = disclosure([name, more], item, entry.path, entry.name, slot);
          this.events.carry(row, at, () => void open());
          previews.set(slot, {path: entry.path, slot});
          observe.observe(slot);
        } else {
          this.events.carry(row, at, null);
          this.events.open(name, at);
        }
        out.push(item);
      }
      return out.length ? out : [note(t('empty'))];
    };

    function qualify(button: HTMLElement, entry: SystemEntry, path: string) {
      const names = (peers.get(entry.name) ?? []).filter(peer => peer.button.isConnected);
      const parent = path.split('/').slice(0, -1);
      // Preserve the shortest useful suffix when two real previews have the same name.
      names.push({button, entry, parent: parent.join('/')});
      peers.set(entry.name, names);
      if (new Set(names.map(peer => peer.parent)).size < 2) return;
      const qualifiers = names.map(({parent}) => {
        const parts = parent.split('/');
        let n = 1;
        while (n < parts.length && names.some(other => other.parent !== parent &&
          other.parent.split('/').slice(-n).join('/') === parts.slice(-n).join('/'))) n++;
        return Array.from(parts.slice(-n).join('/'));
      });
      const first = qualifiers[0]!, shortest = Math.min(...qualifiers.map(label => label.length));
      const different = first.slice(0, shortest).findIndex((ch, n) => qualifiers.some(label => label[n] !== ch));
      const common = different < 0 ? shortest - 8 : different;
      // A long shared prefix would hide the very part that lets the two links be told apart.
      const cut = common >= 14 ? common : 0;
      names.forEach((peer, n) => {
        peer.button.dataset.nearQualified = '';
        peer.button.replaceChildren(h('span', {class: 'near-link-context'},
          (cut ? '…' : '') + qualifiers[n]!.slice(cut).join('')),
          h('span', {class: 'near-link-separator'}, '/'),
          h('span', {class: 'near-link-file'}, peer.entry.name + (peer.entry.kind === 'dir' ? '/' : '')),
          h('span', {class: 'near-link-go', 'aria-hidden': 'true'}, ' →'));
      });
    }

    // Read only the shallow preview earned by a visible slot. Four at a time, no recursive background walk.
    const previewNext = () => {
      while (active < 4 && queue.length && current()) {
        const next = queue.shift()!;
        if (!next.slot.isConnected) continue;
        active++;
        void list(next.path).then(children => {
          if (!current() || !next.slot.isConnected) return;
          record(next.path, children);
          const child = children.find(entry => entry.kind !== 'dir') ?? children[0];
          if (!child) { next.slot.append(h('span', {class: 'file-shelf-preview'}, t('empty'))); return; }
          const at = inRepo(child.path);
          if (!at || at.repo !== repo) return;
          const dir = child.kind === 'dir', suffix = dir ? '/' : '';
          const link = h('button', {class: 'file-shelf-preview file-shelf-shortcut', type: 'button',
            'data-path': child.path, 'aria-label': t('Open {name}', {name: at.path + suffix})}, child.name + suffix,
            h('span', {'aria-hidden': 'true'}, ' →'));
          next.slot.append(link);
          qualify(link, child, at.path);
          if (dir) disclosure([link], next.slot, child.path, child.name);
          else this.events.open(link, at);
        }).catch(() => {}).finally(() => { active--; previewNext(); });
      }
    };
    const observe = new IntersectionObserver(seen => {
      for (const entry of seen) if (entry.isIntersecting) {
        observe.unobserve(entry.target);
        const preview = previews.get(entry.target);
        if (preview) queue.push(preview);
      }
      previewNext();
    }, {root: this.root});
    this.#stop = () => observe.disconnect();
    const scroll = this.root.scrollTop, focused = document.activeElement;
    const path = focused instanceof HTMLElement && this.root.contains(focused) && focused.dataset.path;
    this.events.replace(this.root);
    this.root.replaceChildren(h('li', {class: 'file-shelf-row file-shelf-meta-last', role: 'treeitem', 'aria-label': repo}, heading), ...rows(entries));
    this.root.scrollTop = scroll;
    if (path) (this.root.querySelector<HTMLElement>(`.tree-name[data-path="${CSS.escape(path)}"]`) ?? title).focus({preventScroll: true});
  }
}

// What each part of the stylesheet styles (styles-split.mjs): its file, the comment it starts with, and the
// classes that make a rule its. A rule is the part of the classes its selector is about: from its subject out, the
// first class a part names (a common part's, such as a button's, only when nothing more particular is there); when
// a compound anywhere names a place (Home's column, a board, the Review…), the place's. A rule about several parts at
// once, or none, is shared; a rule with no class at all (an element, an attribute) is the base's.

/**
 * Each part: {name (its file, styles/<name>.css), about (its first comment), classes}. A class ending in * is every
 * class it starts (`tl-*`: tl-post, tl-face…); a class named exactly is taken before any *, and a longer * before a
 * shorter. A class marked ^ is a place: a rule with it on any compound is the place's, whatever its subject is.
 */
export const PARTS = [
  {name: 'tokens', about: 'The tokens every value comes from (DESIGN.md §2): colours, faces, sizes, spaces, corners, the pace of moves, the pointers.', classes: []},
  {name: 'base', about: 'The page and its elements as the OS has them everywhere: boxes, fields, the pointer, scrollbars, focus, words said quietly or small.',
    classes: ['muted', 'small', 'icon', 'sr-only', 'mono', 'kept', 'grow']},
  {name: 'shared', about: 'Rules about many parts at once: the three states every pressable thing has and its touch, a pane\'s heads, what scrolls in its own turn.', classes: []},
  {name: 'controls', about: 'Controls: buttons, chips, a line to type in, a key as it is drawn, the done mark, what is said when something fails.',
    classes: ['button', 'primary', 'chip', 'chips', 'line-in', 'search-in', 'input', 'error', 'row', 'answers', 'link', 'link-name', 'small-button',
      'discard', 'key-hint', 'state-chip', 'done-mark', 'inline-add', 'kind-colon', 'kind-colon-said', 'code-in']},
  {name: 'switch', about: 'The switch: a knob on a track, on in green, and a switch with its word in a card\'s lines.',
    classes: ['power', 'knob', 'net-row']},
  {name: 'menus', about: 'Popovers and menus: one box out of a row, a card or a gear, a head over each group, a row per item.',
    classes: ['pop', 'pop-*', 'row-ask']},
  {name: 'rail', about: 'The rail: its places, their names and dots, and the person at its foot with their menu.',
    classes: ['rail', 'rail-*', 'me', 'me-*', 'opening']},
  {name: 'motion', about: 'The OS\'s moves: the ink going to the thing chosen, a thing opened becoming its box, the camera panning along the rail and the band, the caret gliding to where words are written, a thing just done landing in its place.',
    classes: ['glide-ink', 'morph-*', 'panning', 'panning-across', 'arriving', 'under-ink', 'os-caret', 'os-caret-field', 'caret-copy',
      'landing^', 'just-cut^', 'just-stopped^']},
  {name: 'page', about: 'A page: its head, its sections, room for what is not here yet, a field and its label.',
    classes: ['page', 'page-head', 'section', 'empty', 'boot-static', 'field', 'field-label']},
  {name: 'parts', about: 'A page in parts: the row of its parts, each part\'s panel and the parts within it.',
    classes: ['part-bar', 'parts', 'part', 'part-panel', 'sub-part']},
  {name: 'cards', about: 'Cards and rows: the grid of cards, a repo\'s card and its gear, a card of rows, a card that asks.',
    classes: ['grid', 'card', 'card-*', 'gear-card', 'repo-gear', 'repo-gear-*', 'repo-grid', 'off-ask', 'rows', 'row-item', 'row-name', 'row-meta', 'note', 'ghost']},
  {name: 'small-cards', about: 'Small cards (Prompts running, SSH, Dotfiles, people): their grid, a person\'s card, the card that adds someone, two sections side by side.',
    classes: ['small-grid', 'small-card', 'section-row', 'person-title', 'add-someone', 'add-card', 'add-by-name']},
  {name: 'home', about: 'Home: its column and its pane beside it, as Forge\'s, opening and closing; its repos and servers.',
    classes: ['home-layout^', 'home-pane^', 'home-side^', 'home-bar^', 'home-main', 'home-repos', 'home-servers']},
  {name: 'lately', about: 'Lately\'s rows, in Home\'s pane and come in while one works: who wrote, what about, where.',
    classes: ['lately', 'lately-*', 'pane-word']},
  {name: 'look', about: 'The look a row opens: a card out of the row with what was said, a line to write back, the TODO it is.',
    classes: ['look', 'look-*']},
  {name: 'profile', about: 'Home\'s profile: the face, the name, the handle and the line about the person, the counts, and the profile written in.',
    classes: ['profile', 'avatar', 'identity', 'handle', 'bio', 'unset', 'counts', 'count-go', 'pressable', 'edit', 'edit-acts', 'name-in', 'handle-in',
      'bio-in', 'handle-field', 'bio-field']},
  {name: 'todo', about: 'The TODO box: one sheet to write in, each item a first line and the lines of its detail.',
    classes: ['todo-*']},
  {name: 'git', about: 'Git: its band of repos and its column, the issues listed, an issue written.',
    classes: ['git-*', 'issue-*', 'work-act', 'fetch-*', 'reviewing']},
  {name: 'git-issue', about: 'An issue opened large: its words, its foot, and the issues beside it as boxes side by side.',
    classes: ['issue-big-head', 'issue-no', 'issue-box', 'issue-words', 'issue-foot', 'issue-about', 'issue-column', 'issue-stage', 'issue-track',
      'issue-slot', 'issue-card', 'stage-hit']},
  {name: 'git-review', about: 'The Review in an issue\'s box: its diff with lines marked as with a highlighter, and what was said.',
    classes: ['review-*^', 'stage-head', 'stage-diff', 'markable^', 'marked^', 'marking^']},
  {name: 'git-verdict', about: 'The Review\'s verdict: Approve, its ring turning into the done mark, and Merge under it.',
    classes: ['review-verdict^', 'review-in', 'approve-mark', 'merge-row']},
  {name: 'git-steps', about: 'The steps of an issue (Start, Commit, Push), main\'s card of what is not committed, and what is done with.',
    classes: ['steps', 'step-*', 'issue-steps', 'issue-summary', 'issue-summary-wrap', 'issue-under', 'issue-leave', 'main-*', 'changes', 'done-*', 'handed']},
  {name: 'new-repo', about: 'New repo: the name, what it is for, where it will stand among the repos, and why a name cannot be.',
    classes: ['new-repo^', 'new-repo-wrap^', 'name-field', 'summary-field', 'scaffold-field', 'tree-still^', 'tree-caption', 'tree-new', 'tree-bad',
      'tree-clash', 'tree-other', 'tree-ours', 'bad-char', 'summary-box^', 'made', 'plan-full']},
  {name: 'runtime-env', about: 'Runtime\'s environments: the ones a Prompt can run on, in one card of rows.',
    classes: ['env-*', 'version']},
  {name: 'runtime-storage', about: 'Runtime\'s storage: this OS\'s share of the bar, its legend, what can be given back.',
    classes: ['space-meter', 'legend', 'usage-prompt', 'reclaimed']},
  {name: 'runtime-space', about: 'Runtime\'s three columns: what is here, what can be freed, what is on the Remote.',
    classes: ['space-*', 'gear-room']},
  {name: 'runtime-apps', about: 'Runtime\'s desktop app and its download, and the dotfiles, a row each in one box.',
    classes: ['app-card', 'download', 'dot-*']},
  {name: 'bench', about: 'The bench Forge and Git stand in: the top line, the center, the right pane and its switch, the plugin area.',
    classes: ['work', 'page-work', 'center', 'side', 'bar', 'pane-toggle', 'plugins']},
  {name: 'forge-band', about: 'Forge\'s band: a pill for each repo out, the one worked on in ink, dragged, closed, and ⊕ to bring more out.',
    classes: ['repo-strip', 'pills', 'pill', 'pill-*', 'band-*']},
  {name: 'forge-files', about: 'Forge\'s files: each a sheet with its head, read and written in as a plain text editor, and what the box\'s Edit marks on it.',
    classes: ['flow', 'path', 'path-name', 'file', 'file-*', 'sheet', 'sheet-note', 'gutter', 'code', 'code-edit', 'edit-layer', 'edit-marks', 'edit-mark',
      'edit-pointing', 'edit-ring', 'edit-front', 'unsaved-dot']},
  {name: 'forge-columns', about: 'Forge\'s row of boxes, one per repo out: alone, or side by side with the one worked on, and where a repo dragged in would stand.',
    classes: ['columns', 'col', 'col-*', 'forge-*', 'drop-hint', 'dir']},
  {name: 'prompt', about: 'The prompt box at the foot of the center, what it does (its pill and the modes out of it), and the Prompt up as a screen.',
    classes: ['dock', 'screen^', 'glass', 'prompt', 'prompt-*', 'box-mode', 'box-modes', 'box-mode-*', 'sent-off', 'lamp']},
  {name: 'prompt-pane', about: 'The Prompt read in the pane: each line run and what the box sent, as a thread of what was done.',
    classes: ['term-home^', 'said-*', 'term-said', 'term-said-go']},
  {name: 'terminal', about: 'What a Prompt runs and prints: its lines, its head, how it ended, a line as it was run.',
    classes: ['term', 'term-*', 'run-*']},
  {name: 'search', about: 'The search: its box, what it found under it, each found thing\'s card and the steps between them.',
    classes: ['search-box', 'search-results^', 'search-pills', 'search-panel^', 'search-count', 'search', 'found-*', 'hit-*']},
  {name: 'diff', about: 'A diff: a file\'s lines added and removed, its head, its counts.',
    classes: ['diff', 'diff-*']},
  {name: 'file-tree', about: 'File: the tree of "/" beside the rail, its rows and what can be done to one.',
    classes: ['tree', 'tree-*']},
  {name: 'remote', about: 'The Remote: signing in, a device\'s code, who this device is there, a passkey offered.',
    classes: ['device-*', 'sign-in-*', 'sign-in-card^', 'remote-join', 'standing', 'standing-reach', 'passkey-next', 'offer-holder']},
  {name: 'remote-repos', about: 'The Remote\'s repos: Home\'s cards with what can be done to each at its foot, sharing one, turning one off.',
    classes: ['repo-cards^', 'share', 'share-*']},
  {name: 'plan', about: 'The Remote\'s Plan: the tiers, what one has against them, and the step into paying.',
    classes: ['plan-part^', 'plan-*', 'tier-*', 'meter']},
  {name: 'inbox', about: 'Inbox: the conversations, their messages, someone who wrote first, and writing to someone.',
    classes: ['inbox-*^', 'bubble', 'bubble-*', 'write-hint', 'unread']},
  {name: 'inbox-stub', about: 'Inbox\'s address as a stub, its code, its gear and the names under it.',
    classes: ['stub', 'stub-*', 'record-*']},
  {name: 'server', about: 'Server: its chips on the top line, its boards side by side, its people and repos at the right, what is behind its gear.',
    classes: ['server-*^', 'board-*^', 'slides', 'slide', 'slide-*', 'side-ghost', 'ghost-dock', 'ghost-next', 'your-row', 'people', 'person-go',
      'side-repo', 'side-repos', 'side-part', 'sheet-head', 'sheet-title', 'sheet-body', 'sheet-foot', 'sheet-sub', 'guest-*', 'card-row', 'todo-read', 'seen-*']},
  {name: 'talk', about: 'A board\'s talk: posts one under another, a run of them by one person, what came since.',
    classes: ['timeline', 'tl-*']},
];

/** The part a class names, and whether it names a place: {part, place} or undefined. */
export function classPart(name) {
  return EXACT.get(name) ?? PREFIX.find(([p]) => name.startsWith(p))?.[1];
}

const EXACT = new Map(), PREFIX = [];
for (const p of PARTS) {
  for (const c of p.classes) {
    const place = c.endsWith('^'), k = place ? c.slice(0, -1) : c;
    if (k.endsWith('*')) PREFIX.push([k.slice(0, -1), {part: p.name, place}]);
    else EXACT.set(k, {part: p.name, place});
  }
}
// The longest beginning first: `box-mode-*` before `box-*`.
PREFIX.sort((a, b) => b[0].length - a[0].length);

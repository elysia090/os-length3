#!/usr/bin/env python3
"""Prove which engine owns browser runtime work.

There are two complementary audits:

* ``--web-root`` walks the browser module/Worker graph and rejects reachable
  CPU, MMU, state-step, compiler, or guest-Wasm execution outside ``vm.js``.
* a positional cProfile file classifies a native reference run dynamically.

Python is not a violation by itself.  It remains useful as a build compiler and
as a parity oracle.  A violation is browser-reachable code that owns guest
execution instead of crossing vm.wasm's page/barrier boundary.
"""

import argparse
from collections import Counter, deque
import json
from pathlib import Path
import pstats
import re


_IMPORT_FROM = re.compile(
    r"(?m)^\s*import\s+(?:[^;]*?\s+from\s+)?(['\"])([^'\"]+)\1")
_EXPORT_FROM = re.compile(
    r"(?m)^\s*export\s+[^;]*?\s+from\s+(['\"])([^'\"]+)\1")
_DYNAMIC_LITERAL = re.compile(
    r"\bimport\s*\(\s*(?:/\*.*?\*/\s*)?(['\"])([^'\"]+)\1\s*\)",
    re.DOTALL)
_DYNAMIC_START = re.compile(r"\bimport\s*\(")
_MODULE_URL = re.compile(
    r"\bnew\s+URL\s*\(\s*(['\"])([^'\"]+\.m?js)\1\s*,\s*"
    r"import\.meta\.url\s*\)")
_WORKER_LITERAL = re.compile(
    r"\bnew\s+(?:Shared)?Worker\s*\(\s*(['\"])([^'\"]+\.m?js)\1")
_REGISTER_MODULE = re.compile(
    r"\b(?:register|addModule)\s*\(\s*(['\"])([^'\"]+\.m?js)\1")

# Each rule names ownership, not implementation language.  A function called
# ``runPython`` may legitimately invoke a Python artifact through vm.wasm.  It
# is the concrete Pyodide loader/interpreter object below that creates the
# second owner; Python used by the artifact builder is outside this graph.
_OWNERSHIP_RULES = (
    ('host-language-runtime', re.compile(
        r'\b(?:loadPyodide|[A-Za-z_$][\w$]*\s*\.\s*loadPyodide)\s*\('
        r'|\bpyodide\s*\.\s*runPython\s*\(')),
    ('host-language-memory', re.compile(
        r'\bpyodide\s*\.\s*FS\b|\bnew\s+MemoryFileSystem\b')),
    ('host-wasi-runtime', re.compile(
        r'\bnew\s+WasiPreview1\b|\bhost\s*\.\s*setMemory\s*\(')),
    ('host-x86-control', re.compile(r'\bexecuteX86StateStep\b')),
    ('direct-guest-wasm', re.compile(
        r'\bWebAssembly\s*\.\s*(?:instantiate(?:Streaming)?|compile(?:Streaming)?)\b'
        r'|\bnew\s+WebAssembly\s*\.\s*(?:Module|Instance)\b')),
    ('host-wasm-control', re.compile(
        r'\b(?:instance|moduleInstance)\s*\.\s*exports\b')),
)

_FOUNDATION_OWNERS = frozenset({
    'direct-guest-wasm',
    'host-wasm-control',
})


def _name(key):
    filename, line, function = key
    return '%s:%d(%s)' % (Path(filename).as_posix(), line, function)


def _profile_route(key, project_root=None):
    raw_source = str(key[0])
    if raw_source == '~' or raw_source.startswith('<'):
        return 'support'
    source = Path(raw_source)
    relative = None
    if project_root is not None:
        if source.is_absolute():
            try:
                relative = source.resolve().relative_to(project_root)
            except (OSError, ValueError):
                pass
        elif (source.parts and source.parts[0]
              in ('kernel', 'qm', 'tests', 'tools', 'vm', 'web')):
            relative = source
    parts = () if relative is None else relative.parts
    filename = '' if relative is None else relative.as_posix()
    # A Python function name is not proof that vm.wasm owned the work.  The VM
    # is below the Python profiler boundary, so every sampled project frame is
    # host work during a runtime audit.  More specific buckets only make the
    # remaining owner easy to rank; none is an exemption.
    if parts[:1] == ('qm',):
        if filename == 'qm/stepnormalize.py':
            return 'host-qm-normalize'
        if filename in ('qm/memorycut.py', 'qm/wasmstate.py'):
            return 'host-qm-memory'
        if filename == 'qm/steppage.py':
            return 'host-qm-step'
        return 'host-qm'
    if parts[:1] == ('kernel',):
        if filename == 'kernel/x86.py':
            return 'host-kernel-x86'
        if filename == 'kernel/browser.py':
            return 'host-kernel-bridge'
        return 'host-kernel'
    if parts[:1] == ('tools',):
        return 'host-tool'
    if relative is not None:
        return 'host-project'
    return 'support'


def audit_profile(path, limit=64, phase='runtime'):
    if phase not in ('runtime', 'build', 'oracle'):
        raise ValueError('profile phase must be runtime, build, or oracle')
    profile_path = Path(path).resolve()
    stats = pstats.Stats(str(profile_path)).stats
    project_root = Path(__file__).resolve().parents[1]
    totals = {}
    for key, (_primitive, calls, self_seconds, cumulative, _callers) \
            in stats.items():
        route = _profile_route(key, project_root)
        row = totals.setdefault(route, {
            'calls': 0, 'self_seconds': 0.0, 'cumulative_seconds': 0.0,
        })
        row['calls'] += int(calls)
        row['self_seconds'] += float(self_seconds)
        row['cumulative_seconds'] += float(cumulative)

    edges = []
    for callee, (_primitive, _calls, _self, _cumulative, callers) \
            in stats.items():
        for caller, values in callers.items():
            calls = int(values[1] if len(values) >= 2 else values[0])
            cumulative = float(values[3] if len(values) >= 4 else 0.0)
            caller_route = _profile_route(caller, project_root)
            callee_route = _profile_route(callee, project_root)
            if caller_route == callee_route == 'support':
                continue
            edges.append({
                'caller': _name(caller),
                'caller_route': caller_route,
                'callee': _name(callee),
                'callee_route': callee_route,
                'calls': calls,
                'cumulative_seconds': cumulative,
            })
    edges.sort(key=lambda row: (
        -row['cumulative_seconds'], -row['calls'], row['caller'],
        row['callee']))
    violations = Counter()
    for route, row in totals.items():
        if phase == 'runtime' and route.startswith('host-') and row['calls']:
            violations[route] += row['calls']
    return {
        'kind': 'profile-runtime-route-audit-v1',
        'profile': str(profile_path),
        'phase': phase,
        'routes': dict(sorted(totals.items())),
        'violations': dict(sorted(violations.items())),
        'dominant_edges': edges[:max(1, int(limit))],
    }


# Backwards-compatible entry point used by existing scripts.
audit = audit_profile


def _mask(text, strings):
    """Blank comments, and optionally strings, without changing line offsets."""
    out = list(text)
    quote = None
    escaped = False
    line_comment = False
    block_comment = False
    index = 0
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ''
        if line_comment:
            if char == '\n':
                line_comment = False
            else:
                out[index] = ' '
            index += 1
            continue
        if block_comment:
            if char == '*' and nxt == '/':
                out[index] = out[index + 1] = ' '
                block_comment = False
                index += 2
            else:
                if char != '\n':
                    out[index] = ' '
                index += 1
            continue
        if quote is not None:
            if strings and char != '\n':
                out[index] = ' '
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char == '/' and nxt == '/':
            out[index] = out[index + 1] = ' '
            line_comment = True
            index += 2
            continue
        if char == '/' and nxt == '*':
            out[index] = out[index + 1] = ' '
            block_comment = True
            index += 2
            continue
        if char in "'\"`":
            quote = char
            if strings:
                out[index] = ' '
            index += 1
            continue
        index += 1
    return ''.join(out)


def _line(text, offset):
    return text.count('\n', 0, offset) + 1


def _snippet(text, offset):
    start = text.rfind('\n', 0, offset) + 1
    end = text.find('\n', offset)
    if end < 0:
        end = len(text)
    return text[start:end].strip()[:240]


def _resolve(root, source, specifier):
    if not specifier.startswith(('./', '../')):
        return None
    path = (source.parent / specifier).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if not path.suffix:
        path = path.with_suffix('.js')
    return path if path.is_file() else None


def _module_edges(root, path, text):
    without_comments = _mask(text, strings=False)
    found = []
    literal_spans = []
    for kind, pattern in (
            ('import', _IMPORT_FROM), ('export-from', _EXPORT_FROM),
            ('dynamic-import', _DYNAMIC_LITERAL),
            ('module-url', _MODULE_URL),
            ('worker-literal', _WORKER_LITERAL),
            ('registered-module', _REGISTER_MODULE)):
        for match in pattern.finditer(without_comments):
            specifier = match.group(2)
            if kind == 'dynamic-import':
                literal_spans.append(match.span())
            resolved_specifier = specifier
            # URL("worker.js", import.meta.url) is relative even without the
            # optional ./ prefix; an ESM bare import is not.
            if (kind == 'module-url'
                    and not specifier.startswith(('./', '../', '/'))
                    and '://' not in specifier):
                resolved_specifier = './' + specifier
            target = _resolve(root, path, resolved_specifier)
            found.append({
                'kind': kind,
                'specifier': specifier,
                'line': _line(text, match.start()),
                'target_path': target,
            })
    unresolved = []
    for match in _DYNAMIC_START.finditer(_mask(text, strings=False)):
        if any(begin <= match.start() < end for begin, end in literal_spans):
            continue
        unresolved.append({
            'kind': 'unresolved-dynamic-import',
            'line': _line(text, match.start()),
            'evidence': _snippet(text, match.start()),
        })
    return found, unresolved


def _relative(root, path):
    return path.relative_to(root).as_posix()


def audit_web_runtime(web_root, entries=None, foundation='vm.js'):
    """Walk every statically discoverable browser execution route."""
    root = Path(web_root).resolve()
    entry_names = entries or ['app.js']
    entry_paths = []
    for name in entry_names:
        path = (root / name).resolve()
        try:
            path.relative_to(root)
        except ValueError as error:
            raise ValueError('browser entry escapes web root: %s' % name) from error
        if not path.is_file():
            raise FileNotFoundError(path)
        entry_paths.append(path)

    queue = deque(entry_paths)
    visited = set()
    parents = {path: None for path in entry_paths}
    edges = []
    unresolved = []
    texts = {}
    while queue:
        path = queue.popleft()
        if path in visited:
            continue
        visited.add(path)
        text = path.read_text(encoding='utf-8')
        texts[path] = text
        module_edges, module_unresolved = _module_edges(root, path, text)
        for row in module_unresolved:
            row['path'] = _relative(root, path)
            unresolved.append(row)
        for row in module_edges:
            target = row.pop('target_path')
            edge = {
                'from': _relative(root, path),
                'kind': row['kind'],
                'specifier': row['specifier'],
                'line': row['line'],
                'to': _relative(root, target) if target else None,
            }
            edges.append(edge)
            if target is None:
                unresolved.append({
                    'kind': 'unresolved-module-edge',
                    'path': _relative(root, path),
                    'line': row['line'],
                    'evidence': '%s %s' % (row['kind'], row['specifier']),
                })
            if target is not None and target not in parents:
                parents[target] = path
                queue.append(target)

    def route(path):
        chain = []
        while path is not None:
            chain.append(_relative(root, path))
            path = parents.get(path)
        return list(reversed(chain))

    violations = []
    foundation_path = (root / foundation).resolve()
    for path in sorted(visited):
        text = texts[path]
        code = _mask(text, strings=True)
        for owner, pattern in _OWNERSHIP_RULES:
            if owner in _FOUNDATION_OWNERS and path == foundation_path:
                continue
            # The definition is the violation too: a reachable alternative
            # executor is a live fallback even if this particular trace missed it.
            for match in pattern.finditer(code):
                violations.append({
                    'owner': owner,
                    'path': _relative(root, path),
                    'line': _line(text, match.start()),
                    'evidence': _snippet(text, match.start()),
                    'route': route(path),
                })
    for item in unresolved:
        path = root / item['path']
        owner = ('external-runtime-module'
                 if '://' in item.get('evidence', '')
                 else 'unresolved-runtime-module')
        violations.append({
            'owner': owner,
            'path': item['path'],
            'line': item['line'],
            'evidence': item['evidence'],
            'route': route(path),
        })
    violations.sort(key=lambda row: (row['path'], row['line'], row['owner']))
    counts = Counter(row['owner'] for row in violations)
    by_module = {}
    for row in violations:
        component = by_module.setdefault(row['path'], {
            'module': row['path'], 'route': row['route'],
            'owners': Counter(), 'sites': 0,
        })
        component['owners'][row['owner']] += 1
        component['sites'] += 1
    alternate_owners = [{
        'module': component['module'],
        'route': component['route'],
        'owners': dict(sorted(component['owners'].items())),
        'sites': component['sites'],
    } for component in by_module.values()]
    alternate_owners.sort(key=lambda row: row['module'])
    return {
        'kind': 'browser-runtime-route-audit-v1',
        'web_root': str(root),
        'entries': [_relative(root, path) for path in entry_paths],
        'foundation': foundation,
        'ownership_boundary': {
            'language_neutral': True,
            'rule': (
                'browser-reachable guest state, memory, and control may be '
                'owned only by the vm.wasm foundation; build tools and parity '
                'oracles are outside this runtime graph'
            ),
        },
        'modules': sorted(_relative(root, path) for path in visited),
        'edges': sorted(edges, key=lambda row: (
            row['from'], row['line'], row['kind'], row['specifier'])),
        'alternate_owners': alternate_owners,
        'violation_counts': dict(sorted(counts.items())),
        'violations': violations,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('profile', nargs='?', type=Path)
    parser.add_argument('--web-root', type=Path)
    parser.add_argument('--entry', action='append', default=[])
    parser.add_argument('--foundation', default='vm.js')
    parser.add_argument('--limit', type=int, default=64)
    parser.add_argument('--phase', choices=('runtime', 'build', 'oracle'),
                        default='runtime')
    parser.add_argument('--strict', action='store_true')
    arguments = parser.parse_args(argv)
    if bool(arguments.profile) == bool(arguments.web_root):
        parser.error('provide exactly one of PROFILE or --web-root')
    if arguments.web_root:
        result = audit_web_runtime(
            arguments.web_root, arguments.entry or None,
            foundation=arguments.foundation)
        failed = bool(result['violations'])
    else:
        result = audit_profile(
            arguments.profile, arguments.limit, phase=arguments.phase)
        failed = bool(result['violations'])
    print(json.dumps(result, indent=2, sort_keys=True))
    return int(arguments.strict and failed)


if __name__ == '__main__':
    raise SystemExit(main())

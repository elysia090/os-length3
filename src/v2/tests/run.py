#!/usr/bin/env python3
"""Run the whole suite with no dependencies beyond the standard library.

    python3 tests/run.py            # every core
    python3 tests/run.py -j 1       # one process, plain unittest output
    python3 tests/run.py -v

Most of what this suite does is arithmetic over a declared domain — 65,536
points for a 16-bit kernel, a hundred times over — and one Python process uses
one core to do it. Test classes are handed to a pool of worker processes
instead, which is worth roughly the core count.

The unit of work is a **class**, not a method. `tests/support` memoizes `solve`,
and the tests in one class overwhelmingly ask for the same sources; splitting a
class across workers would trade a shared answer for a recomputed one. Classes
are started longest-first, from the measured order below, so the long ones are
not what everyone waits for at the end.
"""

import io
import multiprocessing
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# Longest first.  This is a scheduling hint measured once, not a fact about the
# tests: a name that is not here simply runs in discovery order, and a name that
# has gone away is ignored.  It only ever changes how long the suite takes.
LONGEST_FIRST = [
    'tests.test_asmfront.TestRoundTrip',
    'tests.test_lanecode.TestIdempotence',
    'tests.test_asmfront.TestReadsItsOwnOutput',
    'tests.test_lanecode.TestMatchesHandWritten',
    'tests.test_lanecode.TestIntrinsics',
    'tests.test_pipeline.TestDeterminism',
    'tests.test_pipeline.TestSpecNumbers',
    'tests.test_browser.TestWorkerProtocolWithRealClang',
]


def discover():
    loader = unittest.TestLoader()
    return loader.discover(os.path.join(ROOT, 'tests'), pattern='test_*.py',
                           top_level_dir=ROOT)


def class_names(suite):
    """Every TestCase class in the suite, in discovery order, once each."""
    names = []
    seen = set()

    def walk(item):
        if isinstance(item, unittest.TestSuite):
            for child in item:
                walk(child)
            return
        cls = type(item)
        name = '%s.%s' % (cls.__module__, cls.__name__)
        if name not in seen:
            seen.add(name)
            names.append(name)

    walk(suite)
    return names


def scheduled(names):
    ranked = dict((name, index) for index, name in enumerate(LONGEST_FIRST))
    return sorted(names, key=lambda n: (ranked.get(n, len(ranked)), n))


def run_class(name):
    """Run one test class; returns (name, tests, [failure text])."""
    suite = unittest.TestLoader().loadTestsFromName(name)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=0).run(suite)
    problems = ['%s\n%s' % (str(case), text)
                for case, text in result.failures + result.errors]
    return name, result.testsRun, problems


def main():
    argv = sys.argv[1:]
    verbosity = 2 if '-v' in argv else 1
    jobs = os.cpu_count() or 1
    if '-j' in argv:
        jobs = int(argv[argv.index('-j') + 1])

    if jobs <= 1:
        result = unittest.TextTestRunner(verbosity=verbosity).run(discover())
        return 0 if result.wasSuccessful() else 1

    names = scheduled(class_names(discover()))
    total = 0
    problems = []
    # fork keeps this cheap: a worker starts with the modules already imported,
    # and — the reason the two pools are separate — with the warmed cache.
    context = multiprocessing.get_context(
        'fork' if 'fork' in multiprocessing.get_all_start_methods() else None)
    workers = min(jobs, len(names))

    from tests import support
    with context.Pool(workers) as pool:
        support.warm(pool)

    with context.Pool(workers) as pool:
        for name, count, failures in pool.imap_unordered(run_class, names):
            total += count
            problems.extend(failures)
            sys.stdout.write('F' * len(failures)
                             + '.' * max(count - len(failures), 0))
            sys.stdout.flush()

    print('\n' + '-' * 70)
    for text in problems:
        print(text)
    print('Ran %d tests in %d classes across %d processes\n'
          % (total, len(names), min(jobs, len(names))))
    print('FAILED (%d)' % len(problems) if problems else 'OK')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())

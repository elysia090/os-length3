#!/usr/bin/env python3
"""Run the whole suite with no dependencies beyond the standard library.

    python3 tests/run.py
    python3 tests/run.py -v
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def main():
    verbosity = 2 if '-v' in sys.argv else 1
    loader = unittest.TestLoader()
    suite = loader.discover(os.path.join(ROOT, 'tests'), pattern='test_*.py',
                            top_level_dir=ROOT)
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())

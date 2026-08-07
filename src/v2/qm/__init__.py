"""Quotient Minimizer — browser-first prototype.

Layering (each layer only imports from lower ones):

    0  bits
    1  guards, observer, semantics, version
    2  quotient, program
    3  cfront/, frontend, isa
    4  solvers, recognize, corpus
    5  pipeline
    6  cli

`pipeline.solve(source)` is the whole product in one call; the web worker and
the CLI are both thin wrappers around it.
"""

from .version import (  # noqa: F401
    GRAMMAR_VERSION, OBJECTIVE_VERSION, QM_VERSION, SOLVER_VERSION,
    version_block,
)

__all__ = ['QM_VERSION', 'GRAMMAR_VERSION', 'OBJECTIVE_VERSION',
           'SOLVER_VERSION', 'version_block', 'solve']


def solve(source, **options):
    """Convenience entry point; see `qm.pipeline.solve`."""
    from .pipeline import solve as _solve
    return _solve(source, **options)

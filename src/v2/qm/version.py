"""Version identifiers for the Quotient Minimizer prototype.

A corpus key has the form

    semantic identity
    x observer
    x target ISA
    x grammar version
    x objective version
    -> canonical result

so grammar and objective versions are first-class data, not comments. Solver
versions describe changes in candidate discovery without invalidating an
already verified minimum under the same grammar and objective.
"""

QM_VERSION = '2.0.0-prototype'

# Bumped when the abstract operation grammar searched by Stage 2 changes.
GRAMMAR_VERSION = 'g3'

# Bumped when the lexicographic objective (span, work, L(z), rank) changes.
OBJECTIVE_VERSION = 'o1'

# Bumped when solver behaviour changes in a way that can move residual freedom.
SOLVER_VERSION = 's4'


def version_block():
    return {
        'qm': QM_VERSION,
        'grammar': GRAMMAR_VERSION,
        'objective': OBJECTIVE_VERSION,
        'solver': SOLVER_VERSION,
    }

"""Semantic keys, local corpus lookup, and opt-in contribution records.

The key is built from the *observed* semantics, not from the source, so two
different C spellings of the same kernel land on the same entry and no source
text is ever needed to look one up.

Nothing here uploads anything.  `contribution_record` returns a blob for the
user to inspect and send by hand; that is what "explicit opt-in" means when the
whole product runs in the browser.

Layer 4: depends on `version`, `semantics`, `observer`.
"""

import hashlib
import json

from .version import GRAMMAR_VERSION, OBJECTIVE_VERSION, SOLVER_VERSION


def semantic_key(sem, obs):
    """Stable identity for (semantics x observer), or None if not canonical.

    A sampled domain has no canonical identity: two different functions can
    agree on the probes.  Returning None is the honest answer there.
    """
    if not sem.domain.exhaustive:
        return None

    hasher = hashlib.sha256()
    hasher.update(b'qm-semantic-key-v1\n')
    hasher.update(('in=%d out=%d obs=%s\n'
                   % (sem.input_bits, sem.output_bits, obs.spec)).encode())
    for y in sem.table():
        value = obs(y)
        hasher.update(int(value).to_bytes(16, 'little'))
    return hasher.hexdigest()


def corpus_entry_key(key, isa_name):
    return '%s|%s|%s|%s' % (key, isa_name, GRAMMAR_VERSION, OBJECTIVE_VERSION)


class Corpus(object):
    """A local, read-only snapshot mapping semantic keys to known minima."""

    def __init__(self, entries=None):
        self.entries = dict(entries or {})

    @classmethod
    def load(cls, path):
        with open(path, 'r') as handle:
            return cls(json.load(handle))

    def lookup(self, key, isa_name):
        if not key:
            return None
        return self.entries.get(corpus_entry_key(key, isa_name))

    def record(self, key, isa_name, payload):
        self.entries[corpus_entry_key(key, isa_name)] = payload

    def dumps(self):
        return json.dumps(self.entries, indent=2, sort_keys=True)


def contribution_record(key, isa_name, result_for_isa, program, recognition):
    """Build an opt-in contribution record without raw source material.

    Raw C and raw assembly are excluded by construction: they are not
    parameters of this function.
    """
    return {
        'canonical_semantic_key': key,
        'observer': result_for_isa.get('observer'),
        'target_isa': isa_name,
        'grammar_version': GRAMMAR_VERSION,
        'objective_version': OBJECTIVE_VERSION,
        'solver_version': SOLVER_VERSION,
        'minimum': {
            'core_ops': program.get('core_ops'),
            'classes': program.get('classes'),
            'span': result_for_isa.get('span'),
            'work': result_for_isa.get('work'),
            'L_bits': result_for_isa.get('L_bits'),
            'instructions': result_for_isa.get('instructions'),
        },
        'residual_freedom': program.get('residual_freedom'),
        'verification': result_for_isa.get('verification'),
        'recognized_as': recognition,
        'state': 'untrusted-candidate',
        'note': 'contains no source text and no assembly from the pasted input',
    }

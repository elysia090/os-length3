"""Monotonic persistent roots over immutable direct-coordinate objects.

Storage providers are byte containers, not authorities.  A volume publishes a
new persistent cut only after every referenced object is present, and advances
its root by compare-and-swap from the expected parent.  Failed or interrupted
publishes leave immutable orphans; collection is fenced by allocation order and
also rechecks every live root and write lease while holding the volume lock.
"""

from dataclasses import dataclass
import hashlib
import struct
from threading import RLock


ZERO_DIGEST = bytes(32)
ROOT_DOMAIN = b'physical persistent root\0'
OBJECT_SET_DOMAIN = b'physical reachable object set\0'
MAX_COUNTER = (1 << 64) - 1


class StorageError(RuntimeError):
    """A persistent storage state transition is invalid."""


class StaleSupervisor(StorageError):
    """A stopped or superseded supervisor attempted to mutate a volume."""


class RootConflict(StorageError):
    """The expected persistent root is no longer current."""


class StorageRetired(StorageError):
    """A finite generation space is exhausted and must not wrap."""


def _digest(payload):
    return hashlib.sha256(bytes(payload)).digest()


def _digest_tuple(items):
    items = tuple(bytes(item) for item in items)
    if any(len(item) != 32 for item in items):
        raise ValueError('object identities must be SHA-256 digests')
    return tuple(sorted(set(items)))


def _object_set_root(objects):
    """Commit a canonical reachability set without copying it into the head."""
    encoded = bytearray(OBJECT_SET_DOMAIN)
    encoded += struct.pack('<Q', len(objects))
    encoded += b''.join(objects)
    return _digest(encoded)


@dataclass(frozen=True)
class SupervisorLease:
    """One durable fencing generation and its restart incarnation."""

    incarnation: bytes
    generation: int

    def __post_init__(self):
        if len(self.incarnation) != 16 or self.generation <= 0:
            raise ValueError('supervisor lease is invalid')


@dataclass(frozen=True)
class WriteLease:
    """Identity of one all-or-nothing root publication attempt."""

    incarnation: bytes
    supervisor_generation: int
    token: int


@dataclass(frozen=True)
class PersistentRoot:
    """One fixed-size pointer to an immutable filesystem cut.

    ``objects`` is a collector-side reachability cache.  The published head
    commits it through ``object_root`` but never serializes the whole set into
    the root descriptor, so filesystem growth does not grow the CAS value.
    """

    sequence: int
    parent: bytes
    manifest: bytes
    object_root: bytes
    objects: tuple
    digest: bytes

    @classmethod
    def create(cls, sequence, parent, manifest, objects):
        sequence = int(sequence)
        parent = bytes(parent)
        manifest = bytes(manifest)
        objects = _digest_tuple(objects)
        if sequence <= 0 or len(parent) != 32 or len(manifest) != 32:
            raise ValueError('persistent root coordinates are invalid')
        if manifest not in objects:
            raise ValueError('persistent root does not retain its manifest')
        object_root = _object_set_root(objects)
        encoded = bytearray(ROOT_DOMAIN)
        encoded += struct.pack('<Q', sequence)
        encoded += parent
        encoded += manifest
        encoded += object_root
        return cls(sequence, parent, manifest, object_root, objects,
                   _digest(encoded))

    @property
    def descriptor(self):
        """Canonical constant-size plaintext sealed before remote storage."""
        return (ROOT_DOMAIN + struct.pack('<Q', self.sequence) + self.parent
                + self.manifest + self.object_root)


class _Intent(object):
    __slots__ = ('lease', 'expected_root', 'objects', 'published')

    def __init__(self, lease, expected_root):
        self.lease = lease
        self.expected_root = bytes(expected_root)
        self.objects = set()
        self.published = None


class PersistentVolume(object):
    """Reference state machine for crash-safe page and block publication.

    The lock represents the single conditional-write primitive required from a
    concrete backing service.  A service without that primitive must keep
    conflicting writers on immutable branches instead of pretending to offer
    one linearizable volume.
    """

    def __init__(self, counter_limit=MAX_COUNTER):
        counter_limit = int(counter_limit)
        if counter_limit < 2 or counter_limit > MAX_COUNTER:
            raise ValueError('counter limit is invalid')
        self._limit = counter_limit
        self._lock = RLock()
        self._supervisor_generation = 0
        self._supervisor = None
        self._next_lease = 1
        self._next_sequence = 1
        self._next_allocation = 1
        self._objects = {}
        self._allocation = {}
        self._intents = {}
        self._completed = {}
        self._roots = {}
        self._current = ZERO_DIGEST
        self._pinned = set()

    def _advance(self, attribute):
        value = int(getattr(self, attribute))
        if value <= 0 or value >= self._limit:
            setattr(self, attribute, 0)
            raise StorageRetired('%s generation is exhausted' %
                                 attribute.lstrip('_'))
        setattr(self, attribute, value + 1)
        return value

    def _check_supervisor(self, supervisor):
        if supervisor != self._supervisor:
            raise StaleSupervisor('supervisor fencing generation is stale')

    def _intent(self, supervisor, lease):
        self._check_supervisor(supervisor)
        if (not isinstance(lease, WriteLease)
                or lease.incarnation != supervisor.incarnation
                or lease.supervisor_generation != supervisor.generation):
            raise StaleSupervisor('write lease belongs to another supervisor')
        intent = self._intents.get(lease.token)
        if intent is None or intent.lease != lease:
            raise StorageError('write lease is not active')
        return intent

    def claim_supervisor(self, incarnation):
        """Fence every older worker or supervisor without reclaiming by time."""
        incarnation = bytes(incarnation)
        if len(incarnation) != 16:
            raise ValueError('supervisor incarnation must be 128 bits')
        with self._lock:
            generation = self._supervisor_generation + 1
            if generation >= self._limit:
                raise StorageRetired('supervisor generation is exhausted')
            self._supervisor_generation = generation
            self._supervisor = SupervisorLease(incarnation, generation)
            return self._supervisor

    def begin(self, supervisor, expected_root=None):
        """Open one publication intent against an exact current root."""
        with self._lock:
            self._check_supervisor(supervisor)
            expected = self._current if expected_root is None \
                else bytes(expected_root)
            if len(expected) != 32:
                raise ValueError('expected root must be a SHA-256 digest')
            token = self._advance('_next_lease')
            lease = WriteLease(
                supervisor.incarnation, supervisor.generation, token)
            self._intents[token] = _Intent(lease, expected)
            return lease

    def put(self, supervisor, lease, payload):
        """Write and retain one immutable object under a publication intent."""
        payload = bytes(payload)
        identity = _digest(payload)
        with self._lock:
            intent = self._intent(supervisor, lease)
            if identity not in self._objects:
                allocation = self._advance('_next_allocation')
                self._objects[identity] = payload
                self._allocation[identity] = allocation
            intent.objects.add(identity)
            return identity

    def retain(self, supervisor, lease, identity):
        """Retain an existing immutable object in the next persistent cut."""
        identity = bytes(identity)
        with self._lock:
            intent = self._intent(supervisor, lease)
            if identity not in self._objects:
                raise StorageError('retained object is absent')
            intent.objects.add(identity)
            return identity

    def publish(self, supervisor, lease, manifest):
        """Durably append a root, or return the same root on exact retry."""
        manifest = bytes(manifest)
        if len(manifest) != 32:
            raise ValueError('manifest identity must be a SHA-256 digest')
        with self._lock:
            self._check_supervisor(supervisor)
            completed = self._completed.get(lease.token)
            if completed is not None:
                root, completed_lease = completed
                if completed_lease == lease and root.manifest == manifest:
                    return root
                raise StorageError('write lease was completed differently')
            intent = self._intent(supervisor, lease)
            if intent.expected_root != self._current:
                raise RootConflict('persistent root compare-and-swap failed')
            if manifest not in intent.objects:
                raise StorageError('manifest is not durable under this lease')
            sequence = self._advance('_next_sequence')
            root = PersistentRoot.create(
                sequence, self._current, manifest, intent.objects)
            self._roots[root.digest] = root
            self._current = root.digest
            intent.published = root.digest
            self._completed[lease.token] = root, lease
            del self._intents[lease.token]
            return root

    def abort(self, supervisor, lease):
        """Drop an unpublished intent; its objects become collectible orphans."""
        with self._lock:
            intent = self._intent(supervisor, lease)
            del self._intents[intent.lease.token]

    def reclaim_stale_intents(self, supervisor):
        """Reclaim only after a new durable supervisor fence has been won."""
        with self._lock:
            self._check_supervisor(supervisor)
            stale = [token for token, intent in self._intents.items()
                     if (intent.lease.incarnation, intent.lease.supervisor_generation)
                     != (supervisor.incarnation, supervisor.generation)]
            for token in stale:
                del self._intents[token]
            return len(stale)

    def pin_root(self, supervisor, identity):
        """Retain a snapshot as a legal future restore target."""
        identity = bytes(identity)
        with self._lock:
            self._check_supervisor(supervisor)
            if identity != self._current and identity not in self._roots:
                raise StorageError('persistent root is unknown')
            if identity != ZERO_DIGEST:
                self._pinned.add(identity)

    def unpin_root(self, supervisor, identity):
        with self._lock:
            self._check_supervisor(supervisor)
            self._pinned.discard(bytes(identity))

    def restore(self, supervisor, identity):
        """Append a new root that references a retained older snapshot."""
        identity = bytes(identity)
        with self._lock:
            self._check_supervisor(supervisor)
            if identity != self._current and identity not in self._pinned:
                raise StorageError('restore target is not retained')
            selected = self._roots.get(identity)
            if selected is None:
                raise StorageError('genesis has no restorable object set')
            sequence = self._advance('_next_sequence')
            root = PersistentRoot.create(
                sequence, self._current,
                selected.manifest, selected.objects)
            self._roots[root.digest] = root
            self._current = root.digest
            return root

    def gc_fence(self, supervisor):
        """Capture the last allocation a collection cycle may consider."""
        with self._lock:
            self._check_supervisor(supervisor)
            return self._next_allocation - 1

    def collect_orphans(self, supervisor, fence):
        """Delete only fenced objects unreachable at the linearized sweep."""
        fence = int(fence)
        with self._lock:
            self._check_supervisor(supervisor)
            if fence < 0 or fence >= self._next_allocation:
                raise ValueError('allocation fence is invalid')
            reachable = set()
            roots = set(self._pinned)
            if self._current != ZERO_DIGEST:
                roots.add(self._current)
            for identity in roots:
                reachable.update(self._roots[identity].objects)
            for intent in self._intents.values():
                reachable.update(intent.objects)
            garbage = [identity for identity, allocation
                       in self._allocation.items()
                       if allocation <= fence and identity not in reachable]
            for identity in garbage:
                del self._allocation[identity]
                del self._objects[identity]
            return tuple(sorted(garbage))

    def get(self, identity):
        """Read an immutable object; callers still verify its identity."""
        identity = bytes(identity)
        with self._lock:
            payload = self._objects.get(identity)
            if payload is None:
                raise KeyError(identity)
            if _digest(payload) != identity:
                raise StorageError('stored object failed integrity verification')
            return payload

    @property
    def current_root(self):
        with self._lock:
            return self._roots.get(self._current)

    @property
    def object_count(self):
        with self._lock:
            return len(self._objects)

    @property
    def active_intents(self):
        with self._lock:
            return len(self._intents)

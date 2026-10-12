# Browser workspace recovery

The release terminal retains its workspace in this browser profile and origin.
The browser is the user-approved recovery authority: IndexedDB keeps the
existing non-extractable HKDF CryptoKey, volume context, trusted ciphertext head
and Supervisor generation. Linux continues to own the filesystem on encrypted
physical blocks.

`linux-workspace` selects an origin-local workspace name; the default is
`default`. `linux-workspace-bytes` sets the extent when it is first created,
between 16 and 256 MiB in multiples of 4096 bytes. Changing that extent for an
existing workspace fails and retains its data. The product verification page
enables the same recovery path with `workspace=NAME`; without that option it
retains its earlier page-local test volume behavior.

One Web Lock holds the live Supervisor lease. Each new incarnation atomically
increments its persisted generation, and physical-store operations reject a
stale generation. Every successful physical-head publication updates the
trusted recovery pin in the same strict IndexedDB transaction. An aborted
transaction changes neither value. Missing authority, unidentified object rows
or a head that differs from the retained pin stop recovery without generating a
replacement key or formatting the existing data.

The origin and browser profile are part of the recovery coordinate. Site-data
deletion removes the key and recovery metadata. This mechanism trusts the local
browser metadata; it does not detect rollback of that entire trusted browser
profile, export raw keys, or recover a legacy page-local key after its page has
been destroyed. The release signature trust remains a separate authority.

Linux `sync` or filesystem barriers commit durable physical writes. Closing and
flushing the Worker retains that committed state. Reopening boots Linux against
the saved block head, including its normal filesystem recovery after an abrupt
shutdown. Dirty Linux page-cache bytes that have not reached the block device
are outside that durability guarantee.
The terminal's Close/Resume controls use that same Worker flush and origin
lease. Resume claims a fresh persisted generation and follows the saved selected
release rather than recreating its key or filesystem.

The fixture [workspace-recovery.html](../vm/check/browser/workspace-recovery.html) exercises real
IndexedDB/CryptoKey recovery, atomic head/pin storage, aborted publication, stale
writers, competing tabs and recovery refusal. It uses an explicit disposable
`fixture-` name. A fresh document is a smaller check than complete browser
process exit/restart; the latter and real Linux file recovery remain required
before calling Web a qualified distribution.

Retained physical checkpoints can restore a committed workspace in a new head
sequence. Restore first authenticates every referenced historical object,
refuses dirty pending writes and invalidates cached current pages after its CAS.
A missing/corrupt snapshot or failed publication retains the current durable
head. Restoring an initially empty snapshot never grants formatting authority.
The diagnostic page exposes retain/restore controls only with both a named
workspace and `faults=1`, and requires its Linux Worker to be closed and flushed.
Up to eight labeled checkpoint envelopes remain in trusted origin metadata;
an occupied label is never silently replaced.

The release terminal prepares all five immutable image/module roles in a
separate origin IndexedDB cache before boot. Its independently supplied release
pin authenticates the descriptor, every 64 KiB body and each whole role. Only
complete preparation publishes the cached descriptor. Reopen uses those bodies
without network delivery. Missing/corrupt bodies stop recovery; a corrupt cache
is not silently replaced. This cache stores public bytes and grants no publisher
or compatibility approval.

A new prepared workspace stores its selected release identity and physical data
directory together in one authenticated head. A mismatched release or a legacy
delivery mode cannot boot that selected workspace. Old unbound workspaces need
an explicit stopped selection; they are not automatically adopted or formatted.
The Supervisor must supply the compatible prior identity and independently
approve the candidate. The selector checks its entire prepared population and
current physical objects before publishing a new head sequence. A retained
checkpoint restores both identities in another new sequence, only after its
prepared release and historical physical objects have been checked.
Terminal recovery reads that selected identity from the authenticated head,
including after rollback; a later configured catalog pin cannot silently select
another release. A missing cache for that retained identity stops recovery.

The diagnostic page enables those operations with a named workspace and
`prepared=1`. `Compatible prior release` requires the exact prior descriptor
digest, or the explicit word `unbound` for legacy adoption. These controls do not
qualify diagnostic images. The public cache fixture
[prepared-release.html](../vm/check/browser/prepared-release.html) also checks
missing/corrupt bodies, occupied-coordinate refusal and no corrupt-cache network
fallback using a small synthetic population that is never executed.

A legacy diagnostic page can explicitly retain the key it still holds: close
and flush its Worker, append `#retain-workspace` to the same pinned Release URL,
then reopen once. The normal Worker verifies the caller's key/head, all current
physical objects and the complete prepared release before registering origin
authority in that existing database. It generates no replacement key and copies
no physical data. It binds an unbound head to the explicitly supplied current
release; an already bound head must match. Existing authority cannot be replaced
with a different context, invalid key/head or stale generation.

The recovery name is `legacy-` followed by the displayed 32-character legacy
volume name. This name form is reserved for explicitly retained volumes and
refuses missing authority without generating a key. After the old Worker closes,
ordinary terminal recovery can use that name, profile and origin. The old page
must remain open until retention succeeds; neither a destroyed page-local key
nor deleted site data can be reconstructed by this migration.

# Package set content binding

This is a build-cache gate, not source provenance, an ELF equivalence proof,
package signature verification, or distribution qualification. The stale
browser root's original producer history remains unknown; this general reuse
gap is not claimed as its historical cause.

`package-root-set-v1` keeps its existing name/path rows. New emitters also
publish `MANIFEST.content`: `package-root-content-v1`, the exact manifest
SHA-256, then sorted package-name/content-identity rows. A missing, conflicting
or incomplete companion is rejected. Existing manifests are returned only
when both files match; neither file is overwritten. Legacy coordinates need
an explicitly selected new output directory, not automatic sealing.

The identity CLI is `artifact-measure-namespace --identity ROOT`. Build it
with `make -C compiler/artifact all` before standalone package builders. The
existing canonical namespace projection covers relative paths, entry types,
permission/special mode bits, numeric uid/gid, symlink bytes, internal hardlink
relationships, device identity, and sorted xattr names/values (including ACLs
and capabilities exposed by Linux xattrs). Exact regular bytes are framed by
their 64-bit extents and hashed once per inode in canonical first-path order.
The domain is `package-root-content-v1`. No archive normalization rewrites
the hashed payload. Filesystem xattr/read errors fail instead of producing a
partial identity.

Absolute root location, filesystem st_dev/st_ino values, timestamps, external
hardlink counts and producer/compiler revisions are not identity coordinates.
They are not copied-byte semantics for this gate. Stat generations/timestamps
are checked only for changes *during* a read. A namespace-format change needs
an explicit contract review; a stronger runtime test need not invalidate
unchanged package bytes. Producer/source and final qualification binding remain
later work.

Capture and assembly use command-owned `cp -a --reflink=auto` snapshots with
independent inodes. Assembly copies the manifest/companion too and parses and
hashes those same private bytes. Each captured package must match its recorded
identity. From then on only private snapshots are consumed: mutation of an
original path after verification cannot change the assembled bytes. A captured
tree is an explicit input cut; it does not certify a producer's build history
or a globally atomic snapshot of concurrently edited source trees.

The existing clone operation may hardlink later packages, but now its sources
are private copies. Cleanup removes those private aliases; published outputs
do not share mutable caller-owned package inodes. Reflink support is optional;
the fallback reads/copies all referenced payload bytes, including on reuse.
Peak scratch holds the captured inputs and the new output's first independent
package copy. This is an explicit build-time cost, not a runtime background scan.

`OUTPUT.package-set` becomes `package-set-assembly-v2` followed by the exact
manifest digest, companion digest and assembled-output digest. Reuse checks
the captured inputs and current output against that record. A legacy marker,
changed input, changed output or unmatched metadata pair fails while retaining
existing files. New output/marker publication is no-clobber; a crash between
their publication leaves a rejected incomplete coordinate, not an automatic
repair. Callers own output coordinates exclusively and treat published
checkpoints as immutable. The gate detects stable drift/read races; it does
not provide protection against an adversarial same-uid writer continuously
changing a published checkpoint after return. Downstream qualification must
still bind the artifact it actually consumes.

The Linux fixture uses only its own isolated temporary roots. It covers fresh
assembly, unchanged reuse/re-emission, same-size byte edits at unchanged paths,
mode/uid/gid/symlink/hardlink/xattr changes, timestamp/root-relocation stability,
xattr-order stability, changed outputs/metadata records, retained legacy data,
and a controlled original-input mutation after snapshot verification. Failure
assertions retain output, marker, manifest, companion and a work-difference
sentinel. `sudo bash distribution/packaging/check-package-set-content.sh` requires
root only to vary numeric ownership in those disposable fixtures. Neither
this fixture nor its CI result certifies the Linux product, DHCP, cold boot,
signing authority or browser recovery.

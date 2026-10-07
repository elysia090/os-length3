/* Derived source admission metadata in an ordinary Wasm custom section.
 * It is not an executable instruction stream or another program authority. */
#ifndef MACHINE_MODULE_H
#define MACHINE_MODULE_H
#include <machine/entry.h>
#include <machine/state.h>
#define MACHINE_SOURCE_SECTION "machine.source"
#define MACHINE_SOURCE_VERSION 1u
#define MACHINE_SOURCE_HEADER_BYTES 32u
#define MACHINE_SOURCE_ROW_BYTES 16u
#define MACHINE_SOURCE_MAX_FUNCTIONS 256u
#define MACHINE_SOURCE_MAX_BYTES 65536u
#define MACHINE_SOURCE_PLAN_BYTES 16u
#define MACHINE_IMAGE_SECTION "machine.image"
#define MACHINE_IMAGE_VERSION 1u
#define MACHINE_IMAGE_HEADER_BYTES 64u
#define MACHINE_IMAGE_RANGE_BYTES 16u
#define MACHINE_IMAGE_MAX_RANGES 64u
#define MACHINE_IMAGE_PLAN_BYTES 24u
/* Image header: version/state ABI/entry ABI/source count (four u32), range
 * count/witness bytes/two zeros (four u32), canonical source digest[32].
 * Ranges: original first coordinate u64, count/witness bytes u16, zero u32.
 * Source lengths minus one follow as low-then-high 4-bit digits (1..15 bytes;
 * digit 15 invalid; unused high digit zero). Witnesses concatenate in range
 * order; their offsets and source ranks are strict prefix sums, not columns.
 * An image plan DTO is prefix offset/bytes u32, immutable bias u64, source
 * count/zero u32. ENTRY is a fixed ordinary export, not a runtime opcode. */
/* Supervisor DTO: verified executable prefix offset/bytes and selected export
 * ordinal/count (four u32). No host canonical-row/source-instruction parser. */
/* Little endian header: version, state ABI, entry ABI, function count (u32),
 * source generation (u64), witness page count (u32, one or two), zero (u32).
 * Rows: source offset u32, bytes/instructions/admitted limit/zero u16, scalar
 * binding u32. Export rank is the row ordinal, not a stored second column.
 * Exact source pages follow once. They are a derived comparison witness;
 * canonical storage must share their owner with the accepted source bytes.
 * The section is last: the preceding bytes are themselves ordinary executable
 * Wasm, authenticated as an exact subview of this same verified object. */
#endif

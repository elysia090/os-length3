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

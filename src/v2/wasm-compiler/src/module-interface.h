/* Construction-time names and types; never a runtime operation stream. */
#ifndef WASM_MODULE_INTERFACE_H
#define WASM_MODULE_INTERFACE_H
#include "internal.h"
enum wasm_machine_import {
    WASM_IMPORT_ACCESS, WASM_IMPORT_RESERVE, WASM_IMPORT_COMMIT,
    WASM_IMPORT_WRITE_BEGIN, WASM_IMPORT_WRITE_WORD, WASM_IMPORT_WRITE_END,
    WASM_IMPORT_SEGMENT, WASM_IMPORT_RESERVE_PAIR, WASM_IMPORT_COMMIT_PAIR,
    WASM_IMPORT_TABLE, WASM_IMPORT_READ_PAIR, WASM_IMPORT_READ_EXTENT,
    WASM_IMPORT_FAR_RETURN, WASM_IMPORT_CONTROL, WASM_IMPORT_IRET,
    WASM_IMPORT_MSR, WASM_IMPORT_DEBUG, WASM_IMPORT_IO, WASM_IMPORT_TIME,
    WASM_IMPORT_INTERRUPT_FLAG, WASM_IMPORT_SOFTWARE_INTERRUPT,
    WASM_IMPORT_SYSTEM_TRANSFER, WASM_IMPORT_FLOATING_WAIT, WASM_IMPORT_CHECKPOINT, WASM_IMPORT_DESCRIPTOR, WASM_IMPORT_COUNT
};
_Static_assert(WASM_IMPORT_COUNT<32u && WASM_IMPORT_COUNT<128u,"bounded machine interface");
#define WASM_IMPORT_MASK ((1u<<WASM_IMPORT_COUNT)-1u)

/* A callback is assigned by typed identity, not a per-cut hardcoded index.
 * Signature-equal callbacks share a type but retain distinct function imports. */
void wasm_import_map(pl_u32 mask,pl_u32 slots[WASM_IMPORT_COUNT]);
pl_u32 wasm_import_count(pl_u32 mask);
pl_u32 wasm_uleb_bytes(pl_u64 value);
void wasm_module_prefix(wasm_writer *writer,pl_u32 imports,pl_u32 functions,
    pl_u64 code_payload_bytes);
/* Source exports may alias an exact shared body. No forwarding functions. */
void wasm_module_alias_prefix(wasm_writer *writer,pl_u32 imports,pl_u32 functions,
    pl_u32 exports,const pl_u16 *ranks,pl_u64 code_payload_bytes);
/* One ordinary entry dispatcher plus an immutable loader-supplied i64 bias. */
void wasm_module_image_prefix(wasm_writer *writer,pl_u32 imports,pl_u32 functions,
    pl_u32 exports,const pl_u16 *ranks,pl_u64 code_payload_bytes);
#endif

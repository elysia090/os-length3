#ifndef VM_MODULE_H
#define VM_MODULE_H
#include <machine/module.h>
#define VM_MODULE_ERROR_INPUT (-150)
#define VM_MODULE_ERROR_ABI (-151)
#define VM_MODULE_ERROR_SOURCE (-152)
#define VM_MODULE_ERROR_ABSENT (-153)
#define VM_MODULE_ERROR_TAIL (-154)
typedef struct {
    const pl_u8 *rows,*source;
    pl_u64 generation;
    pl_u32 code_bytes,count,pages;
} vm_module;
typedef struct {
    pl_u32 source_offset,source_bytes,source_instructions,limit,export_rank,operand_binding;
} vm_module_entry;
/* Caller first authenticates the complete immutable object and pins it until
 * engine consumption/source publication. This parser checks the canonical
 * descriptor, not guest opcodes, source equivalence, Wasm function type or
 * whole-machine closure. A selected/authenticated trusted compiler root must
 * separately bind the admitted CPU/load/code context. No payload is copied.
 * Failure leaves outputs unchanged. There is no metadata-less fallback. */
int vm_module_open(const pl_u8 *bytes,pl_u32 length,vm_module *out);
int vm_module_find(const vm_module *module,pl_u64 generation,pl_u32 source_offset,
    pl_u32 limit,vm_module_entry *out);
#endif

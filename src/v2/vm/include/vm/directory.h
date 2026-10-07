/* One authenticated Artifact path; no object-sized directory or ISA reader. */
#ifndef VM_DIRECTORY_H
#define VM_DIRECTORY_H
#include <artifact/resource.h>

enum { VM_DIRECTORY_CLOSED, VM_DIRECTORY_IDLE, VM_DIRECTORY_NODE,
       VM_DIRECTORY_OBJECT, VM_DIRECTORY_READY };
#define VM_DIRECTORY_ERROR_INPUT (-140)
#define VM_DIRECTORY_ERROR_STALE (-141)
#define VM_DIRECTORY_ERROR_BUSY (-142)
#define VM_DIRECTORY_ERROR_EXHAUSTED (-143)

typedef struct {
    pl_index_ref root, pending;
    pl_index_key key;
    artifact_resource resource;
    pl_u64 generation, sequence, ticket;
    pl_u32 maximum_object_bytes;
    pl_u8 stage, kind;
    pl_u16 reserved;
} vm_directory;

/* Initialize with {0}. The supervisor must first authenticate/trust this root
 * as the selected release/program projection. Hashing a self-chosen root is
 * NOT authorization or a compiler equivalence proof. Serialize this owner.
 * Failed reopen closes the previous binding. Close preserves ticket history;
 * a destroyed/restarted owner needs a fresh non-reused outer authority scope. */
void vm_directory_close(vm_directory *directory);
void vm_directory_cancel(vm_directory *directory);
int vm_directory_open(vm_directory *directory, const pl_index_ref *root,
    pl_u64 generation, pl_u32 maximum_object_bytes);
/* The requested role is part of admission: a valid memory-page row cannot
 * satisfy a module request, even when its payload happens to be valid Wasm. */
/* IMAGE_MODULE uses authenticated predecessor/range lookup in original ELF
 * coordinates. The exclusive end must contain the requested coordinate;
 * holes and the last interval's end refuse. Other roles retain exact lookup.
 * Object identity readiness is not image execution/source/bias admission. */
int vm_directory_begin(vm_directory *directory, pl_u64 generation, pl_index_key key,
    pl_u32 expected_kind);
/* Return 1 only after an authenticated leaf selected one bounded resource;
 * otherwise zero requests the next <=4 KiB node. Failure leaves the pending
 * request intact for retry and cannot publish a row/object. */
int vm_directory_node(vm_directory *directory, pl_u64 generation, pl_u64 ticket,
    const pl_u8 *bytes, pl_u32 length);
int vm_directory_object(vm_directory *directory, pl_u64 generation, pl_u64 ticket,
    const pl_u8 *bytes, pl_u32 length);
/* Only READY authorizes the exact verified immutable byte witness. The caller
 * pins that buffer until the engine consumes it; do not refetch it or switch
 * bytes after verification. This proves Artifact identity, not Wasm type,
 * executable source/MMU identity, full x86 closure or tier confidentiality. */
#endif

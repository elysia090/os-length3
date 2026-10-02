/* Scalar RAM transaction boundary; guest addresses never become host pointers. */
#ifndef MACHINE_MEMORY_H
#define MACHINE_MEMORY_H
#include <support/types.h>
#include <stddef.h>

#define MACHINE_MEMORY_ABI_VERSION 1u

enum machine_memory_access {
    MACHINE_MEMORY_READ = 1u,
    MACHINE_MEMORY_WRITE = 2u,
    MACHINE_MEMORY_STACK = 4u,
};

/* One private port per serialized execution lane. A fault is a pending CPU
 * exception, not an injected interrupt and not a retired instruction. The
 * supervisor delivers it at the unchanged RIP. In particular it owns CR2 and
 * exception entry. Port generation is set only by that supervisor. */
typedef struct {
    pl_u64 generation;
    pl_u64 value;
    pl_u64 fault_address;
    pl_u32 fault_vector;
    pl_u32 fault_error;
    pl_u64 request_address;
    pl_u32 request_bytes;
    pl_u32 request_access;
} machine_memory_port;

_Static_assert(sizeof(machine_memory_port) == 48u, "memory port ABI extent");
_Static_assert(offsetof(machine_memory_port, value) == 8u, "memory value ABI");
_Static_assert(offsetof(machine_memory_port, fault_address) == 16u, "memory fault ABI");
_Static_assert(offsetof(machine_memory_port, request_address) == 32u, "memory request ABI");

/* Generated memory cuts import machine.access:
 * (i32 port, i64 linear_address, i32 bytes, i32 access, i64 value) -> i64 result.
 * DIRECT/0 commits a complete scalar transaction and supplies port.value for
 * reads. Other results perform no RAM write; FAULT updates only the fault
 * fields, BARRIER only the request fields. That complete address/range/right
 * request lets admission proceed without decoding the source instruction.
 * BARRIER requests translation/residency/device admission, never a
 * source-instruction interpreter. No concurrent remap/eviction is permitted
 * during the synchronous call. The provider is C VM code, not a JS syscall. */
#endif

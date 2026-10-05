/* Bounded RAM transaction boundary; guest addresses never become host pointers. */
#ifndef MACHINE_MEMORY_H
#define MACHINE_MEMORY_H
#include <support/types.h>
#include <stddef.h>

#define MACHINE_MEMORY_ABI_VERSION 1u

enum machine_memory_access {
    MACHINE_MEMORY_READ = 1u,
    MACHINE_MEMORY_WRITE = 2u,
    MACHINE_MEMORY_STACK = 4u,
    MACHINE_MEMORY_ALIGNED16 = 32u, /* Ordered extent/pair preflight only. */
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

/* A double-word reservation extends, never aliases, the scalar fault/request
 * fields. Both words are private outputs of one complete read/write preflight.
 * Nothing is published on a fault or wait. The lane is serialized and pinned
 * through commit; this is not a shared-memory/SMP atomicity contract. */
typedef struct {
    machine_memory_port scalar;
    pl_u64 high;
} machine_memory_pair_port;
_Static_assert(sizeof(machine_memory_pair_port) == 56u, "pair port ABI extent");
_Static_assert(offsetof(machine_memory_pair_port, high) == 48u, "pair high word ABI");

/* A synchronous borrowed read view, never a payload image. Offsets are relative
 * to the provider's arena in C and rebased to Wasm linear memory by its adapter.
 * Complete preflight publishes at most two fragments on success only. The
 * serialized compiled call keeps RAM/directory/context pinned until it returns;
 * no event, yield, remap or guest write may interleave. These descriptors confer
 * no authority after that call. No source opcode or CPU image crosses the API. */
typedef struct {
    machine_memory_port scalar;
    pl_u32 offsets[2], lengths[2];
} machine_memory_extent_port;
_Static_assert(sizeof(machine_memory_extent_port)==64u,"borrowed extent port ABI");

/* machine.read_pair(port,address,16,READ[|STACK|ALIGNED16]) -> result:
 * complete read-only preflight publishes scalar.value/high only on success.
 * Unaligned records may cross two pages; faults/waits leave both words and
 * CPU/payload unchanged. There is no retained RMW reservation or opcode.
 * The same private pair-port extent applies to generated register SIMD cuts
 * only when they have a memory operand; register-only cuts use the scalar
 * fault port. Architectural paging A/D effects are not rolled back. */

/* machine.reserve_pair(port,address,16,READ|WRITE[|STACK]) -> result:
 * validates a 16-byte aligned range, supplies scalar.value/high and retains
 * its single reservation. machine.commit_pair(port,low,high) -> result:
 * consumes that entire reservation once. Neither import receives an opcode. */

/* Generated memory cuts import machine.access:
 * (i32 port, i64 linear_address, i32 bytes, i32 access, i64 value) -> i64 result.
 * DIRECT/0 commits a complete scalar transaction and supplies port.value for
 * reads. Other results perform no payload store; architectural page-table A/D
 * updates may already have occurred. FAULT publishes the fault fields;
 * BARRIER the request fields. That complete address/range/right
 * request lets admission proceed without decoding the source instruction.
 * Providers may mark a residency request as physical (bit 4); do not interpret
 * its address as a guest linear pointer. BARRIER requests admission, never a
 * source-instruction interpreter. No concurrent remap/eviction is permitted
 * during the synchronous call. The provider is C VM code, not a JS syscall. */

/* Bounded ordered record output uses three generic C imports:
 * write_begin(i32 port,i64 address,i32 bytes,i32 WRITE[|STACK|ALIGNED16]) -> i64
 * write_word(i32 port,i32 relative_offset,i32 bytes,i64 value) -> i64
 * write_end(i32 port) -> i64
 * begin preflights 1..512 bytes, publishing no payload. word writes 1..8
 * bytes at a nondecreasing, nonoverlapping cursor into pinned physical
 * fragments; holes are left unchanged. end consumes the frontier. None
 * receives an opcode, an image pointer or an architectural CPU snapshot.
 * No yield/remap/event/second vCPU intervenes. CPU retirement follows end;
 * a host trap closes/aborts before reuse, without undoing completed stores. */
#endif

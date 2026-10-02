/* Scoped admission of bounded asynchronous host operations. */

#ifndef VM_RESOURCE_H
#define VM_RESOURCE_H

#include <support/types.h>

#define VM_RESOURCE_OK 0
#define VM_RESOURCE_DUPLICATE 1
#define VM_RESOURCE_ERROR_INPUT     (-120)
#define VM_RESOURCE_ERROR_DENIED    (-121)
#define VM_RESOURCE_ERROR_STALE     (-122)
#define VM_RESOURCE_ERROR_BUSY      (-123)
#define VM_RESOURCE_ERROR_RANGE     (-124)
#define VM_RESOURCE_ERROR_EXHAUSTED (-125)

enum vm_resource_kind {
    VM_RESOURCE_OBJECT = 1,
    VM_RESOURCE_NETWORK,
    VM_RESOURCE_FILE,
    VM_RESOURCE_CONSOLE,
    VM_RESOURCE_SERIAL,
};

enum vm_resource_right {
    VM_RESOURCE_READ = 1u,
    VM_RESOURCE_WRITE = 2u,
};

typedef struct {
    pl_u64 authority[2];
    pl_u64 workspace[2];
    pl_u64 resource;
    pl_u64 generation;
    pl_u64 revision;
    pl_u32 lane;
} vm_resource_address;

typedef struct {
    vm_resource_address address;
    pl_u64 first;
    pl_u64 extent;
    pl_u32 maximum_bytes;
    pl_u32 rights;
    pl_u32 kind;
} vm_resource_grant;

typedef struct {
    vm_resource_address address;
    pl_u64 offset;
    pl_u32 bytes;
    pl_u32 right;
} vm_resource_request;

typedef struct {
    vm_resource_address address;
    pl_u64 sequence;
} vm_resource_ticket;

/* One cell per independent bounded batch lane. Initialize with {0}; serialize
 * all calls at its owner. This is not shared mutable Worker memory or an atomic
 * permission oracle. The host broker must first establish actual consent and a
 * non-reused authority/workspace/resource/lane binding. Distinct lanes of one
 * resource have distinct lane ranks even if their sequence values coincide.
 * No function allocates data. */
typedef struct {
    vm_resource_grant grant;
    pl_u64 issued;
    pl_u64 pending;
    pl_u64 completed;
    pl_u64 cancelled;
    pl_u32 pending_bytes;
    pl_u32 completed_bytes;
    pl_u32 initialized;
    pl_u32 live;
} vm_resource_gate;

/* Privileged supervisor operation, never a guest-module import. The gate does
 * not verify consent credentials by itself. Invalid replacement leaves the old
 * grant/reservation unchanged. Rebind keeps
 * the same authority/workspace/resource/lane/kind, advances generation or revision,
 * never decreases either, and fences any old completion. Sequence exhaustion
 * is terminal for this cell; a new authority scope must not reuse an old one. */
int vm_resource_bind(vm_resource_gate *gate, const vm_resource_grant *grant);

/* Requests name the complete current address, one direction and a nonempty
 * interval. Failure does not change the gate or output ticket. One lane cannot
 * have two pending batches; independent lanes do not wait on one global gate. */
int vm_resource_begin(vm_resource_gate *gate,
                      const vm_resource_request *request,
                      vm_resource_ticket *ticket);

/* OK admits the transport completion exactly once; it does not authenticate its
 * payload, publish a filesystem root or prove durable storage. DUPLICATE has no
 * side effects. Cancellation/revocation fence late replies but cannot undo an
 * operation already performed externally. The caller releases payload buffers
 * when completion/cancellation succeeds or a binding is fenced. */
int vm_resource_complete(vm_resource_gate *gate,
                         const vm_resource_ticket *ticket,
                         pl_u32 completed_bytes);
int vm_resource_cancel(vm_resource_gate *gate,
                       const vm_resource_ticket *ticket);
int vm_resource_revoke(vm_resource_gate *gate);

#endif /* VM_RESOURCE_H */

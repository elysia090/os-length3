#include <vm/resource.h>
#include <support/checked.h>

static int same_identity(const vm_resource_address *left,
                          const vm_resource_address *right)
{
    return left->authority[0] == right->authority[0]
        && left->authority[1] == right->authority[1]
        && left->workspace[0] == right->workspace[0]
        && left->workspace[1] == right->workspace[1]
        && left->resource == right->resource && left->lane == right->lane;
}

static int same_address(const vm_resource_address *left,
                         const vm_resource_address *right)
{
    return same_identity(left, right)
        && left->generation == right->generation
        && left->revision == right->revision;
}

static int valid_grant(const vm_resource_grant *grant)
{
    return (grant->address.authority[0] || grant->address.authority[1])
        && (grant->address.workspace[0] || grant->address.workspace[1])
        && grant->address.resource && grant->address.generation
        && grant->address.revision && grant->extent && grant->maximum_bytes
        && grant->rights && !(grant->rights & ~3u)
        && grant->kind >= VM_RESOURCE_OBJECT && grant->kind <= VM_RESOURCE_SERIAL
        && pl_checked_add_u64(grant->first, grant->extent, 0);
}

int vm_resource_bind(vm_resource_gate *gate, const vm_resource_grant *grant)
{
    if (!gate || !grant || gate->initialized > 1u || !valid_grant(grant))
        return VM_RESOURCE_ERROR_INPUT;
    if (gate->initialized) {
        const vm_resource_address *current = &gate->grant.address;
        if (!same_identity(current, &grant->address)
                || gate->grant.kind != grant->kind
                || grant->address.generation < current->generation
                || grant->address.revision < current->revision
                || (grant->address.generation == current->generation
                    && grant->address.revision == current->revision))
            return VM_RESOURCE_ERROR_STALE;
        if (gate->issued == ~0ull) return VM_RESOURCE_ERROR_EXHAUSTED;
    } else {
        gate->issued = 0u;
    }
    gate->grant = *grant;
    gate->pending = 0u;
    gate->completed = 0u;
    gate->cancelled = 0u;
    gate->pending_bytes = 0u;
    gate->completed_bytes = 0u;
    gate->initialized = 1u;
    gate->live = 1u;
    return VM_RESOURCE_OK;
}

int vm_resource_begin(vm_resource_gate *gate,
                      const vm_resource_request *request,
                      vm_resource_ticket *ticket)
{
    pl_u64 relative;
    if (!gate || !request || !ticket) return VM_RESOURCE_ERROR_INPUT;
    if (!gate->initialized || !gate->live) return VM_RESOURCE_ERROR_DENIED;
    if (!same_address(&gate->grant.address, &request->address))
        return VM_RESOURCE_ERROR_STALE;
    if ((request->right != VM_RESOURCE_READ && request->right != VM_RESOURCE_WRITE)
            || !(gate->grant.rights & request->right))
        return VM_RESOURCE_ERROR_DENIED;
    if (!request->bytes || request->bytes > gate->grant.maximum_bytes
            || request->offset < gate->grant.first)
        return VM_RESOURCE_ERROR_RANGE;
    relative = request->offset - gate->grant.first;
    if (!pl_checked_extent(relative, request->bytes, gate->grant.extent))
        return VM_RESOURCE_ERROR_RANGE;
    if (gate->pending) return VM_RESOURCE_ERROR_BUSY;
    if (gate->issued == ~0ull) return VM_RESOURCE_ERROR_EXHAUSTED;
    ++gate->issued;
    gate->pending = gate->issued;
    gate->pending_bytes = request->bytes;
    *ticket = (vm_resource_ticket){ gate->grant.address, gate->issued };
    return VM_RESOURCE_OK;
}

int vm_resource_complete(vm_resource_gate *gate,
                         const vm_resource_ticket *ticket,
                         pl_u32 completed_bytes)
{
    if (!gate || !ticket) return VM_RESOURCE_ERROR_INPUT;
    if (!gate->initialized || !gate->live || !ticket->sequence
            || !same_address(&gate->grant.address, &ticket->address))
        return VM_RESOURCE_ERROR_STALE;
    if (ticket->sequence == gate->completed)
        return completed_bytes == gate->completed_bytes
             ? VM_RESOURCE_DUPLICATE : VM_RESOURCE_ERROR_INPUT;
    if (ticket->sequence != gate->pending) return VM_RESOURCE_ERROR_STALE;
    if (completed_bytes > gate->pending_bytes) return VM_RESOURCE_ERROR_RANGE;
    gate->completed = gate->pending;
    gate->completed_bytes = completed_bytes;
    gate->pending = 0u;
    gate->pending_bytes = 0u;
    return VM_RESOURCE_OK;
}

int vm_resource_cancel(vm_resource_gate *gate,
                       const vm_resource_ticket *ticket)
{
    if (!gate || !ticket) return VM_RESOURCE_ERROR_INPUT;
    if (!gate->initialized || !gate->live || !ticket->sequence
            || !same_address(&gate->grant.address, &ticket->address))
        return VM_RESOURCE_ERROR_STALE;
    if (ticket->sequence == gate->cancelled) return VM_RESOURCE_DUPLICATE;
    if (ticket->sequence != gate->pending) return VM_RESOURCE_ERROR_STALE;
    gate->cancelled = gate->pending;
    gate->pending = 0u;
    gate->pending_bytes = 0u;
    return VM_RESOURCE_OK;
}

int vm_resource_revoke(vm_resource_gate *gate)
{
    if (!gate) return VM_RESOURCE_ERROR_INPUT;
    if (!gate->initialized) return VM_RESOURCE_ERROR_INPUT;
    if (!gate->live) return VM_RESOURCE_DUPLICATE;
    gate->live = 0u;
    gate->pending = 0u;
    gate->pending_bytes = 0u;
    return VM_RESOURCE_OK;
}

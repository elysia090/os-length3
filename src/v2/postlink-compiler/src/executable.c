#include <postlink/executable.h>
#include <postlink/residual.h>

static const pl_u8 EXECUTABLE_MAGIC[PL_EXECUTABLE_MAGIC_BYTES] =
    PL_EXECUTABLE_MAGIC;

_Static_assert(sizeof(pl_executable_state) == PL_EXECUTABLE_STATE_BYTES,
               "canonical executable state layout drifted");

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index)
        difference |= (pl_u32)(left[index] ^ right[index]);
    return difference == 0u;
}

static void copy_bytes(pl_u8 *target, const pl_u8 *source, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        target[index] = source[index];
}

static void zero_bytes(pl_u8 *target, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index) target[index] = 0u;
}

static int nonzero_digest(const pl_u8 digest[PL_EXECUTABLE_DIGEST_BYTES])
{
    pl_u32 any = 0u;
    for (pl_u32 index = 0u; index < PL_EXECUTABLE_DIGEST_BYTES; ++index)
        any |= digest[index];
    return any != 0u;
}

static int extent_fits(pl_u64 offset, pl_u64 bytes, pl_u64 length)
{
    return offset <= length && bytes <= length - offset;
}

static int state_shape(const pl_executable_state *state)
{
    if (!state || !(state->rflags & 2u) || (state->mxcsr & ~0xffffu)
            || state->msr_count > PL_VM_X86_MSR_WORDS)
        return PL_ERROR_EXECUTABLE;
    for (pl_u32 left = 0u; left < state->msr_count; ++left) {
        if (state->msr_keys[left] > 0xffffffffu)
            return PL_ERROR_EXECUTABLE;
        for (pl_u32 right = 0u; right < left; ++right)
            if (state->msr_keys[left] == state->msr_keys[right])
                return PL_ERROR_EXECUTABLE;
    }
    for (pl_u32 index = state->msr_count;
         index < PL_VM_X86_MSR_WORDS; ++index)
        if (state->msr_keys[index] || state->msr_values[index])
            return PL_ERROR_EXECUTABLE;
    return 0;
}

int pl_executable_state_read(
        const pl_u8 bytes[PL_EXECUTABLE_STATE_BYTES],
        pl_executable_state *out)
{
    if (!bytes || !out) return PL_ERROR_EXECUTABLE;
    pl_executable_state state = { 0 };
    for (pl_u32 index = 0u; index < PL_VM_X86_REGISTER_COUNT; ++index)
        state.registers[index] = pl_read_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_REGISTERS + index * 8u);
    for (pl_u32 index = 0u; index < PL_VM_X86_XMM_WORDS; ++index)
        state.xmm[index] = pl_read_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_XMM + index * 8u);
    state.rip = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_RIP);
    state.rflags = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_RFLAGS);
    state.cr0 = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_CR0);
    state.cr3 = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_CR3);
    state.cr4 = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_CR4);
    state.efer = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_EFER);
    for (pl_u32 index = 0u; index < PL_VM_X86_SYSTEM_WORDS; ++index)
        state.system[index] = pl_read_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_SYSTEM + index * 8u);
    state.msr_count = pl_read_u32(
        bytes + PL_EXECUTABLE_STATE_OFF_MSR_COUNT);
    state.mxcsr = pl_read_u32(bytes + PL_EXECUTABLE_STATE_OFF_MXCSR);
    for (pl_u32 index = 0u; index < PL_VM_X86_MSR_WORDS; ++index) {
        state.msr_keys[index] = pl_read_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_MSR_KEYS + index * 8u);
        state.msr_values[index] = pl_read_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_MSR_VALUES + index * 8u);
    }
    state.retired = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_RETIRED);
    state.work = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_WORK);
    state.span = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_SPAN);
    for (pl_u32 index = 0u; index < PL_VM_X86_X87_REGISTERS; ++index) {
        state.x87_significand[index] = pl_read_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_X87_SIGNIFICAND + index * 8u);
        state.x87_sign_exponent[index] = (pl_u16)pl_read_u16(
            bytes + PL_EXECUTABLE_STATE_OFF_X87_SIGN_EXPONENT + index * 2u);
    }
    state.x87_control = (pl_u16)pl_read_u16(
        bytes + PL_EXECUTABLE_STATE_OFF_X87_CONTROL);
    state.x87_status = (pl_u16)pl_read_u16(
        bytes + PL_EXECUTABLE_STATE_OFF_X87_STATUS);
    state.x87_tag = (pl_u16)pl_read_u16(
        bytes + PL_EXECUTABLE_STATE_OFF_X87_TAG);
    state.x87_opcode = (pl_u16)pl_read_u16(
        bytes + PL_EXECUTABLE_STATE_OFF_X87_OPCODE);
    state.x87_ip = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_X87_IP);
    state.x87_dp = pl_read_u64(bytes + PL_EXECUTABLE_STATE_OFF_X87_DP);
    int status = state_shape(&state);
    if (status) return status;
    *out = state;
    return 0;
}

int pl_executable_state_write(
        const pl_executable_state *state,
        pl_u8 bytes[PL_EXECUTABLE_STATE_BYTES])
{
    int status = state_shape(state);
    if (status || !bytes) return status ? status : PL_ERROR_EXECUTABLE;
    zero_bytes(bytes, PL_EXECUTABLE_STATE_BYTES);
    for (pl_u32 index = 0u; index < PL_VM_X86_REGISTER_COUNT; ++index)
        pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_REGISTERS + index * 8u,
                     state->registers[index]);
    for (pl_u32 index = 0u; index < PL_VM_X86_XMM_WORDS; ++index)
        pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_XMM + index * 8u,
                     state->xmm[index]);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_RIP, state->rip);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_RFLAGS, state->rflags);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_CR0, state->cr0);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_CR3, state->cr3);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_CR4, state->cr4);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_EFER, state->efer);
    for (pl_u32 index = 0u; index < PL_VM_X86_SYSTEM_WORDS; ++index)
        pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_SYSTEM + index * 8u,
                     state->system[index]);
    pl_write_u32(bytes + PL_EXECUTABLE_STATE_OFF_MSR_COUNT,
                 state->msr_count);
    pl_write_u32(bytes + PL_EXECUTABLE_STATE_OFF_MXCSR, state->mxcsr);
    for (pl_u32 index = 0u; index < PL_VM_X86_MSR_WORDS; ++index) {
        pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_MSR_KEYS + index * 8u,
                     state->msr_keys[index]);
        pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_MSR_VALUES + index * 8u,
                     state->msr_values[index]);
    }
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_RETIRED, state->retired);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_WORK, state->work);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_SPAN, state->span);
    for (pl_u32 index = 0u; index < PL_VM_X86_X87_REGISTERS; ++index) {
        pl_write_u64(
            bytes + PL_EXECUTABLE_STATE_OFF_X87_SIGNIFICAND + index * 8u,
            state->x87_significand[index]);
        pl_write_u16(
            bytes + PL_EXECUTABLE_STATE_OFF_X87_SIGN_EXPONENT + index * 2u,
            state->x87_sign_exponent[index]);
    }
    pl_write_u16(bytes + PL_EXECUTABLE_STATE_OFF_X87_CONTROL,
                 state->x87_control);
    pl_write_u16(bytes + PL_EXECUTABLE_STATE_OFF_X87_STATUS,
                 state->x87_status);
    pl_write_u16(bytes + PL_EXECUTABLE_STATE_OFF_X87_TAG,
                 state->x87_tag);
    pl_write_u16(bytes + PL_EXECUTABLE_STATE_OFF_X87_OPCODE,
                 state->x87_opcode);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_X87_IP, state->x87_ip);
    pl_write_u64(bytes + PL_EXECUTABLE_STATE_OFF_X87_DP, state->x87_dp);
    return 0;
}

static int binding_shape(const pl_executable_binding *binding)
{
    if (!binding
            || (binding->virtual_page & (PL_EXECUTABLE_PAGE_BYTES - 1u))
            || binding->reserved
            || binding->source_bytes > PL_EXECUTABLE_PAGE_BYTES
            || !nonzero_digest(binding->digest))
        return PL_ERROR_EXECUTABLE_BINDING;
    if (binding->source_offset == PL_EXECUTABLE_SOURCE_DERIVED
            && binding->source_bytes != PL_EXECUTABLE_PAGE_BYTES)
        return PL_ERROR_EXECUTABLE_BINDING;
    return 0;
}

int pl_executable_binding_validate(const pl_executable_binding *binding,
                                   pl_u64 source_bytes,
                                   pl_u32 function_count)
{
    int status = binding_shape(binding);
    if (status || !function_count
            || binding->generation > 0xffffffffu
            || binding->dispatch_function >= function_count)
        return PL_ERROR_EXECUTABLE_BINDING;
    if (binding->source_offset != PL_EXECUTABLE_SOURCE_DERIVED
            && !extent_fits(binding->source_offset, binding->source_bytes,
                            source_bytes))
        return PL_ERROR_EXECUTABLE_BINDING;
    return 0;
}

int pl_executable_binding_read(const pl_u8 row[PL_EXECUTABLE_BINDING_BYTES],
                               pl_executable_binding *out)
{
    if (!row || !out) return PL_ERROR_EXECUTABLE_BINDING;
    out->virtual_page = pl_read_u64(row);
    out->generation = pl_read_u64(row + 8u);
    out->source_offset = pl_read_u64(row + 16u);
    out->source_bytes = pl_read_u32(row + 24u);
    out->dispatch_function = pl_read_u32(row + 28u);
    out->dispatch_argument = pl_read_u32(row + 32u);
    out->reserved = pl_read_u32(row + 36u);
    copy_bytes(out->digest, row + 40u, PL_EXECUTABLE_DIGEST_BYTES);
    return binding_shape(out);
}

int pl_executable_binding_write(const pl_executable_binding *binding,
                                pl_u8 row[PL_EXECUTABLE_BINDING_BYTES])
{
    int status = binding_shape(binding);
    if (status || !row) return status ? status : PL_ERROR_EXECUTABLE_BINDING;
    pl_write_u64(row, binding->virtual_page);
    pl_write_u64(row + 8u, binding->generation);
    pl_write_u64(row + 16u, binding->source_offset);
    pl_write_u32(row + 24u, binding->source_bytes);
    pl_write_u32(row + 28u, binding->dispatch_function);
    pl_write_u32(row + 32u, binding->dispatch_argument);
    pl_write_u32(row + 36u, 0u);
    copy_bytes(row + 40u, binding->digest, PL_EXECUTABLE_DIGEST_BYTES);
    return 0;
}

static int module_shape(const pl_executable_module *module)
{
    if (!module || module->key_minor || !module->function_count
            || module->first_function > 0xffffffffu
            || module->function_count
               > 0xffffffffu - (pl_u32)module->first_function
            || module->flags != PL_EXECUTABLE_MODULE_WASM32
            || module->payload_bytes < 8u
            || !nonzero_digest(module->digest))
        return PL_ERROR_EXECUTABLE_MODULE;
    return 0;
}

int pl_executable_module_validate(const pl_executable_module *module,
                                  pl_u32 function_count)
{
    int status = module_shape(module);
    if (status || (pl_u32)module->first_function >= function_count
            || module->function_count
               > function_count - (pl_u32)module->first_function)
        return PL_ERROR_EXECUTABLE_MODULE;
    return 0;
}

int pl_executable_module_read(const pl_u8 row[PL_EXECUTABLE_MODULE_BYTES],
                              pl_executable_module *out)
{
    if (!row || !out) return PL_ERROR_EXECUTABLE_MODULE;
    out->first_function = pl_read_u64(row);
    out->key_minor = pl_read_u64(row + 8u);
    out->payload_bytes = pl_read_u64(row + 16u);
    out->function_count = pl_read_u32(row + 24u);
    out->flags = pl_read_u32(row + 28u);
    copy_bytes(out->digest, row + 32u, PL_EXECUTABLE_DIGEST_BYTES);
    return module_shape(out);
}

int pl_executable_module_write(const pl_executable_module *module,
                               pl_u8 row[PL_EXECUTABLE_MODULE_BYTES])
{
    int status = module_shape(module);
    if (status || !row) return status ? status : PL_ERROR_EXECUTABLE_MODULE;
    pl_write_u64(row, module->first_function);
    pl_write_u64(row + 8u, 0u);
    pl_write_u64(row + 16u, module->payload_bytes);
    pl_write_u32(row + 24u, module->function_count);
    pl_write_u32(row + 28u, module->flags);
    copy_bytes(row + 32u, module->digest, PL_EXECUTABLE_DIGEST_BYTES);
    return 0;
}

static int resource_shape(const pl_executable_resource *resource)
{
    int entry_page = resource
                  && resource->kind
                     == PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS;
    int entry_tail = resource
                  && resource->kind
                     == PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW;
    int entry = entry_page || entry_tail;
    int residual_state = resource
                      && resource->kind
                         == PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE;
    int residual_edge = resource
                     && resource->kind
                        == PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE;
    int instantiation = resource
                     && resource->kind
                        == PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE;
    int parameter = resource
                 && resource->kind
                    == PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE;
    int projection = entry || residual_state || residual_edge
                   || instantiation || parameter;
    if (!resource || resource->key_minor || !resource->object_bytes
            || !resource->mapped_bytes
            || resource->object_bytes > resource->mapped_bytes
            || resource->page_bytes != PL_EXECUTABLE_PAGE_BYTES
            || (!instantiation && resource->projection_argument)
            || !(resource->flags & PL_EXECUTABLE_RESOURCE_READ_ONLY)
            || (resource->flags & ~PL_EXECUTABLE_RESOURCE_FLAGS)
            || (!projection && (resource->physical_address
                & (PL_EXECUTABLE_PAGE_BYTES - 1u)))
            || (resource->mapped_bytes
                & (PL_EXECUTABLE_PAGE_BYTES - 1u))
            || resource->mapped_bytes
               > ~(pl_u64)0 - resource->physical_address
            || !nonzero_digest(resource->digest)
            || (resource->kind != PL_EXECUTABLE_RESOURCE_MEMORY_BASE
                && resource->kind
                   != PL_EXECUTABLE_RESOURCE_MEMORY_EXTENT
                && !projection))
        return PL_ERROR_EXECUTABLE_RESOURCE;
    if (resource->kind == PL_EXECUTABLE_RESOURCE_MEMORY_BASE
            && (resource->physical_address
                || resource->object_bytes != resource->mapped_bytes
                || resource->flags
                   != (PL_EXECUTABLE_RESOURCE_READ_ONLY
                       | PL_EXECUTABLE_RESOURCE_SPARSE)))
        return PL_ERROR_EXECUTABLE_RESOURCE;
    /* A cold immutable object is the smallest unit the machine can touch and
     * authenticate: one physical page.  Larger filesystem objects belong in
     * the resource index as adjacent page rows.  Keeping that invariant here
     * lets vm.wasm verify a complete digest before admitting one requested
     * page; a host can never authenticate a byte range by merely asserting the
     * digest of some larger object. */
    if (resource->kind == PL_EXECUTABLE_RESOURCE_MEMORY_EXTENT
            && (resource->mapped_bytes != PL_EXECUTABLE_PAGE_BYTES
                || resource->object_bytes > PL_EXECUTABLE_PAGE_BYTES
                || (resource->flags & PL_EXECUTABLE_RESOURCE_SPARSE)))
        return PL_ERROR_EXECUTABLE_RESOURCE;
    if (projection) {
        pl_u64 prefix = resource->physical_address
                      & ~PL_EXECUTABLE_RESOURCE_PROJECTION_RANK_MASK;
        pl_u64 expected = entry_page
            ? PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_BASE
            : entry_tail
                ? PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_BASE
                : residual_state
                    ? PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_BASE
                    : residual_edge
                        ? PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_BASE
                        : instantiation
                            ? PL_EXECUTABLE_RESOURCE_INSTANTIATION_BASE
                            : PL_EXECUTABLE_RESOURCE_PARAMETER_BASE;
        pl_u64 bytes = entry_page ? PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES
                     : entry_tail ? PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES
                     : residual_state ? PL_RESIDUAL_STATE_PAGE_USED
                     : residual_edge ? PL_RESIDUAL_EDGE_PAGE_USED
                     : instantiation ? PL_INSTANTIATION_PAGE_USED
                                     : resource->object_bytes;
        int parameter_extent = !parameter
            || (bytes >= PL_PARAMETER_PAGE_HEADER + 8u
                && bytes <= PL_PARAMETER_PAGE_BYTES
                && !((bytes - PL_PARAMETER_PAGE_HEADER) & 7u));
        if (prefix != expected || resource->object_bytes != bytes
                || resource->mapped_bytes != PL_EXECUTABLE_PAGE_BYTES
                || resource->flags != PL_EXECUTABLE_RESOURCE_READ_ONLY
                || !parameter_extent)
            return PL_ERROR_EXECUTABLE_RESOURCE;
    }
    return 0;
}

int pl_executable_resource_validate(const pl_executable_resource *resource,
                                    pl_u64 memory_bytes)
{
    int status = resource_shape(resource);
    if (status || !memory_bytes)
        return PL_ERROR_EXECUTABLE_RESOURCE;
    if (resource->kind == PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS
            || resource->kind == PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW
            || resource->kind
               == PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE
            || resource->kind
               == PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE
            || resource->kind
               == PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE
            || resource->kind
               == PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE)
        return 0;
    if (resource->physical_address > memory_bytes
            || resource->mapped_bytes
               > memory_bytes - resource->physical_address)
        return PL_ERROR_EXECUTABLE_RESOURCE;
    if (resource->kind == PL_EXECUTABLE_RESOURCE_MEMORY_BASE
            && resource->mapped_bytes != memory_bytes)
        return PL_ERROR_EXECUTABLE_RESOURCE;
    return 0;
}

int pl_executable_resource_read(
    const pl_u8 row[PL_EXECUTABLE_RESOURCE_BYTES],
    pl_executable_resource *out)
{
    if (!row || !out) return PL_ERROR_EXECUTABLE_RESOURCE;
    out->physical_address = pl_read_u64(row);
    out->key_minor = pl_read_u64(row + 8u);
    out->object_bytes = pl_read_u64(row + 16u);
    out->mapped_bytes = pl_read_u64(row + 24u);
    out->page_bytes = pl_read_u32(row + 32u);
    out->kind = pl_read_u32(row + 36u);
    out->flags = pl_read_u32(row + 40u);
    out->projection_argument = pl_read_u32(row + 44u);
    copy_bytes(out->digest, row + 48u, PL_EXECUTABLE_DIGEST_BYTES);
    return resource_shape(out);
}

int pl_executable_resource_write(
    const pl_executable_resource *resource,
    pl_u8 row[PL_EXECUTABLE_RESOURCE_BYTES])
{
    int status = resource_shape(resource);
    if (status || !row) return status ? status : PL_ERROR_EXECUTABLE_RESOURCE;
    pl_write_u64(row, resource->physical_address);
    pl_write_u64(row + 8u, 0u);
    pl_write_u64(row + 16u, resource->object_bytes);
    pl_write_u64(row + 24u, resource->mapped_bytes);
    pl_write_u32(row + 32u, resource->page_bytes);
    pl_write_u32(row + 36u, resource->kind);
    pl_write_u32(row + 40u, resource->flags);
    pl_write_u32(row + 44u, resource->projection_argument);
    copy_bytes(row + 48u, resource->digest, PL_EXECUTABLE_DIGEST_BYTES);
    return 0;
}

static int key_in(pl_index_key key, const pl_index_ref *ref)
{
    return pl_index_key_compare(key, ref->first) >= 0
        && pl_index_key_compare(key, ref->last) <= 0;
}

static int validate_root_values(const pl_executable *root)
{
    if (!root) return PL_ERROR_EXECUTABLE;
    if (!root->function_count
            || root->entry_function >= root->function_count
            || state_shape(&root->state)
            || root->state.rip != root->entry_rip
            || !root->entry_page_count || !root->entry_tail_row_count)
        return PL_ERROR_EXECUTABLE_ABI;
    if (!root->source_bytes || !nonzero_digest(root->source_digest)
            || !root->memory_bytes
            || (root->memory_bytes & (PL_EXECUTABLE_PAGE_BYTES - 1u))
            || !root->external_bytes
            || pl_index_ref_validate(&root->bindings)
            || pl_index_ref_validate(&root->modules)
            || pl_index_ref_validate(&root->resources)
            || root->bindings.leaf_row_bytes != PL_EXECUTABLE_BINDING_BYTES
            || root->modules.leaf_row_bytes != PL_EXECUTABLE_MODULE_BYTES
            || root->resources.leaf_row_bytes != PL_EXECUTABLE_RESOURCE_BYTES)
        return PL_ERROR_EXECUTABLE;

    if (root->residual_flags & ~PL_EXECUTABLE_RESIDUAL_GRAPH)
        return PL_ERROR_EXECUTABLE_ABI;
    if (!(root->residual_flags & PL_EXECUTABLE_RESIDUAL_GRAPH)) {
        if (root->residual_count || root->residual_edge_count
                || root->entry_residual || root->instantiation_count
                || root->parameter_word_count)
            return PL_ERROR_EXECUTABLE_ABI;
    } else if (!root->residual_count || !root->residual_edge_count
            || !root->instantiation_count
            || root->residual_count > 0xffffffu
            || root->instantiation_count > 0xffffffu
            || root->function_count > 0xffffffu
            || root->parameter_word_count > (1u << 24u)
            || root->entry_residual >= root->residual_count) {
        return PL_ERROR_EXECUTABLE_ABI;
    }

    pl_u64 entry_page = root->entry_rip
                      & ~((pl_u64)PL_EXECUTABLE_PAGE_BYTES - 1u);
    if (!key_in((pl_index_key){ entry_page, root->entry_generation },
                &root->bindings)
            || (root->bindings.first.major
                & (PL_EXECUTABLE_PAGE_BYTES - 1u))
            || (root->bindings.last.major
                & (PL_EXECUTABLE_PAGE_BYTES - 1u)))
        return PL_ERROR_EXECUTABLE_BINDING;
    if (root->modules.first.major || root->modules.first.minor
            || root->modules.last.minor
            || root->modules.last.major >= root->function_count)
        return PL_ERROR_EXECUTABLE_MODULE;
    pl_u64 final_resource =
        pl_executable_entry_tail_key(root->entry_tail_row_count - 1u);
    if (root->resources.first.major || root->resources.first.minor
            || root->resources.last.minor
            || root->resources.last.major != final_resource)
        return PL_ERROR_EXECUTABLE_RESOURCE;
    if ((root->residual_flags & PL_EXECUTABLE_RESIDUAL_GRAPH)
            && (!key_in((pl_index_key){
                    pl_executable_residual_state_key(
                        (root->residual_count - 1u)
                        / PL_RESIDUAL_STATE_PAGE_STATES), 0u },
                    &root->resources)
                || !key_in((pl_index_key){
                    pl_executable_residual_edge_key(
                        (root->residual_edge_count - 1u)
                        / PL_RESIDUAL_EDGE_PAGE_EDGES), 0u },
                    &root->resources)
                || !key_in((pl_index_key){
                    pl_executable_instantiation_key(
                        (root->instantiation_count - 1u)
                        / PL_INSTANTIATION_PAGE_ROWS), 0u },
                    &root->resources)
                || (root->parameter_word_count
                    && !key_in((pl_index_key){
                        pl_executable_parameter_key(
                            (root->parameter_word_count - 1u)
                            / PL_PARAMETER_PAGE_WORDS), 0u },
                        &root->resources))))
        return PL_ERROR_EXECUTABLE_RESOURCE;
    return 0;
}

int pl_executable_open(const pl_u8 *bytes, pl_u64 length,
                       pl_executable *out)
{
    if (!bytes || !out || length != PL_EXECUTABLE_HEADER_BYTES)
        return PL_ERROR_EXECUTABLE_RANGE;
    if (!same_bytes(bytes + PL_EXECUTABLE_OFF_MAGIC, EXECUTABLE_MAGIC,
                    PL_EXECUTABLE_MAGIC_BYTES))
        return PL_ERROR_MAGIC;
    if (pl_read_u32(bytes + PL_EXECUTABLE_OFF_VERSION)
                != PL_EXECUTABLE_VERSION
            || pl_read_u32(bytes + PL_EXECUTABLE_OFF_HEADER_BYTES)
                != PL_EXECUTABLE_HEADER_BYTES
            || pl_read_u32(bytes + PL_EXECUTABLE_OFF_ABI_VERSION)
                != PL_VM_ABI_VERSION
            || pl_read_u32(bytes + PL_EXECUTABLE_OFF_PAGE_BYTES)
                != PL_EXECUTABLE_PAGE_BYTES)
        return PL_ERROR_EXECUTABLE_ABI;
    if (pl_read_u32(bytes + PL_EXECUTABLE_OFF_DIGEST_ALGORITHM)
                != PL_EXECUTABLE_DIGEST_SHA256
            || pl_read_u32(bytes + PL_EXECUTABLE_OFF_FLAGS)
                != PL_EXECUTABLE_REQUIRED_FLAGS)
        return PL_ERROR_EXECUTABLE;
    if (pl_read_u64(bytes + PL_EXECUTABLE_OFF_FILE_BYTES)
                != PL_EXECUTABLE_HEADER_BYTES)
        return PL_ERROR_EXECUTABLE_RANGE;

    pl_executable parsed = {
        .entry_rip = pl_read_u64(bytes + PL_EXECUTABLE_OFF_ENTRY_RIP),
        .entry_generation =
            pl_read_u64(bytes + PL_EXECUTABLE_OFF_ENTRY_GENERATION),
        .entry_function =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_ENTRY_FUNCTION),
        .function_count =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_FUNCTION_COUNT),
        .source_bytes = pl_read_u64(bytes + PL_EXECUTABLE_OFF_SOURCE_BYTES),
        .memory_bytes = pl_read_u64(bytes + PL_EXECUTABLE_OFF_MEMORY_BYTES),
        .external_bytes =
            pl_read_u64(bytes + PL_EXECUTABLE_OFF_EXTERNAL_BYTES),
        .entry_page_count =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_ENTRY_PAGE_COUNT),
        .entry_tail_row_count =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_ENTRY_TAIL_ROW_COUNT),
        .residual_count =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_RESIDUAL_COUNT),
        .residual_edge_count =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_RESIDUAL_EDGE_COUNT),
        .entry_residual =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_ENTRY_RESIDUAL),
        .residual_flags =
            pl_read_u32(bytes + PL_EXECUTABLE_OFF_RESIDUAL_FLAGS),
        .instantiation_count = pl_read_u32(
            bytes + PL_EXECUTABLE_OFF_INSTANTIATION_COUNT),
        .parameter_word_count = pl_read_u32(
            bytes + PL_EXECUTABLE_OFF_PARAMETER_WORD_COUNT),
    };
    copy_bytes(parsed.source_digest,
               bytes + PL_EXECUTABLE_OFF_SOURCE_DIGEST,
               PL_EXECUTABLE_DIGEST_BYTES);
    if (pl_index_ref_read(bytes + PL_EXECUTABLE_OFF_BINDING_INDEX,
                          &parsed.bindings)
            || pl_index_ref_read(bytes + PL_EXECUTABLE_OFF_MODULE_INDEX,
                                 &parsed.modules)
            || pl_index_ref_read(bytes + PL_EXECUTABLE_OFF_RESOURCE_INDEX,
                                 &parsed.resources))
        return PL_ERROR_EXECUTABLE;
    if (pl_executable_state_read(
            bytes + PL_EXECUTABLE_OFF_STATE, &parsed.state))
        return PL_ERROR_EXECUTABLE;
    int status = validate_root_values(&parsed);
    if (status) return status;
    *out = parsed;
    return 0;
}

static int validate_spec(const pl_executable_spec *spec,
                         pl_executable *root)
{
    if (!spec || !root || !spec->source_digest || !spec->state || !spec->bindings
            || !spec->modules || !spec->resources)
        return PL_ERROR_EXECUTABLE;
    *root = (pl_executable){
        .entry_rip = spec->entry_rip,
        .entry_generation = spec->entry_generation,
        .entry_function = spec->entry_function,
        .function_count = spec->function_count,
        .source_bytes = spec->source_bytes,
        .memory_bytes = spec->memory_bytes,
        .external_bytes = spec->external_bytes,
        .entry_page_count = spec->entry_page_count,
        .entry_tail_row_count = spec->entry_tail_row_count,
        .residual_count = spec->residual_count,
        .residual_edge_count = spec->residual_edge_count,
        .entry_residual = spec->entry_residual,
        .residual_flags = spec->residual_flags,
        .instantiation_count = spec->instantiation_count,
        .parameter_word_count = spec->parameter_word_count,
        .state = *spec->state,
        .bindings = *spec->bindings,
        .modules = *spec->modules,
        .resources = *spec->resources,
    };
    copy_bytes(root->source_digest, spec->source_digest,
               PL_EXECUTABLE_DIGEST_BYTES);
    return validate_root_values(root);
}

int pl_executable_measure(const pl_executable_spec *spec, pl_u64 *bytes)
{
    pl_executable root;
    if (!bytes) return PL_ERROR_EXECUTABLE;
    int status = validate_spec(spec, &root);
    if (status) return status;
    *bytes = PL_EXECUTABLE_HEADER_BYTES;
    return 0;
}

int pl_executable_write(const pl_executable_spec *spec, pl_u8 *target,
                        pl_u64 capacity, pl_u64 *written)
{
    pl_executable root;
    if (!target || !written || capacity < PL_EXECUTABLE_HEADER_BYTES)
        return PL_ERROR_EXECUTABLE_RANGE;
    int status = validate_spec(spec, &root);
    if (status) return status;
    zero_bytes(target, PL_EXECUTABLE_HEADER_BYTES);
    copy_bytes(target + PL_EXECUTABLE_OFF_MAGIC, EXECUTABLE_MAGIC,
               PL_EXECUTABLE_MAGIC_BYTES);
    pl_write_u32(target + PL_EXECUTABLE_OFF_VERSION, PL_EXECUTABLE_VERSION);
    pl_write_u32(target + PL_EXECUTABLE_OFF_HEADER_BYTES,
                 PL_EXECUTABLE_HEADER_BYTES);
    pl_write_u32(target + PL_EXECUTABLE_OFF_ABI_VERSION, PL_VM_ABI_VERSION);
    pl_write_u32(target + PL_EXECUTABLE_OFF_PAGE_BYTES,
                 PL_EXECUTABLE_PAGE_BYTES);
    pl_write_u32(target + PL_EXECUTABLE_OFF_DIGEST_ALGORITHM,
                 PL_EXECUTABLE_DIGEST_SHA256);
    pl_write_u32(target + PL_EXECUTABLE_OFF_FLAGS,
                 PL_EXECUTABLE_REQUIRED_FLAGS);
    pl_write_u64(target + PL_EXECUTABLE_OFF_ENTRY_RIP, root.entry_rip);
    pl_write_u64(target + PL_EXECUTABLE_OFF_ENTRY_GENERATION,
                 root.entry_generation);
    pl_write_u32(target + PL_EXECUTABLE_OFF_ENTRY_FUNCTION,
                 root.entry_function);
    pl_write_u32(target + PL_EXECUTABLE_OFF_FUNCTION_COUNT,
                 root.function_count);
    pl_write_u64(target + PL_EXECUTABLE_OFF_SOURCE_BYTES, root.source_bytes);
    copy_bytes(target + PL_EXECUTABLE_OFF_SOURCE_DIGEST, root.source_digest,
               PL_EXECUTABLE_DIGEST_BYTES);
    pl_write_u64(target + PL_EXECUTABLE_OFF_MEMORY_BYTES, root.memory_bytes);
    pl_write_u64(target + PL_EXECUTABLE_OFF_EXTERNAL_BYTES,
                 root.external_bytes);
    pl_write_u32(target + PL_EXECUTABLE_OFF_ENTRY_PAGE_COUNT,
                 root.entry_page_count);
    pl_write_u32(target + PL_EXECUTABLE_OFF_ENTRY_TAIL_ROW_COUNT,
                 root.entry_tail_row_count);
    pl_write_u32(target + PL_EXECUTABLE_OFF_RESIDUAL_COUNT,
                 root.residual_count);
    pl_write_u32(target + PL_EXECUTABLE_OFF_RESIDUAL_EDGE_COUNT,
                 root.residual_edge_count);
    pl_write_u32(target + PL_EXECUTABLE_OFF_ENTRY_RESIDUAL,
                 root.entry_residual);
    pl_write_u32(target + PL_EXECUTABLE_OFF_RESIDUAL_FLAGS,
                 root.residual_flags);
    pl_write_u32(target + PL_EXECUTABLE_OFF_INSTANTIATION_COUNT,
                 root.instantiation_count);
    pl_write_u32(target + PL_EXECUTABLE_OFF_PARAMETER_WORD_COUNT,
                 root.parameter_word_count);
    if (pl_index_ref_write(&root.bindings,
                           target + PL_EXECUTABLE_OFF_BINDING_INDEX)
            || pl_index_ref_write(&root.modules,
                                  target + PL_EXECUTABLE_OFF_MODULE_INDEX)
            || pl_index_ref_write(&root.resources,
                                  target + PL_EXECUTABLE_OFF_RESOURCE_INDEX))
        return PL_ERROR_EXECUTABLE;
    if (pl_executable_state_write(
            &root.state, target + PL_EXECUTABLE_OFF_STATE))
        return PL_ERROR_EXECUTABLE;
    pl_write_u64(target + PL_EXECUTABLE_OFF_FILE_BYTES,
                 PL_EXECUTABLE_HEADER_BYTES);
    *written = PL_EXECUTABLE_HEADER_BYTES;
    pl_executable checked;
    return pl_executable_open(target, *written, &checked);
}

static int is_wasm32(const pl_u8 *payload, pl_u64 bytes)
{
    return bytes >= 8u && payload[0] == 0u && payload[1] == 'a'
        && payload[2] == 's' && payload[3] == 'm'
        && payload[4] == 1u && payload[5] == 0u
        && payload[6] == 0u && payload[7] == 0u;
}

int pl_executable_validate_module_payload(
    const pl_executable_module *module, const pl_u8 *payload, pl_u64 bytes)
{
    if (module_shape(module) || !payload || bytes != module->payload_bytes
            || !is_wasm32(payload, bytes))
        return PL_ERROR_EXECUTABLE_MODULE;
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256_digest(payload, bytes, digest);
    return same_bytes(digest, module->digest, PL_SHA256_BYTES)
         ? 0 : PL_ERROR_EXECUTABLE_MODULE;
}

int pl_executable_validate_resource_extent(
    const pl_executable_resource *resource, pl_u64 bytes)
{
    return resource_shape(resource) || bytes != resource->object_bytes
         ? PL_ERROR_EXECUTABLE_RESOURCE : 0;
}

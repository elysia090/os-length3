/* Collision-safe conservative transfer interning. */

#include <postlink/transfer.h>

static int power_of_two(pl_u32 value)
{
    return value && (value & (value - 1u)) == 0u;
}

int pl_transfer_builder_open(pl_transfer_builder *builder,
                             const pl_x86_image *image,
                             pl_transfer_identity *identities,
                             pl_u32 identity_capacity,
                             pl_u32 *hash_slots,
                             pl_u32 hash_slot_count)
{
    if (!builder || !image || !identities || !identity_capacity
            || !hash_slots || hash_slot_count <= identity_capacity
            || !power_of_two(hash_slot_count))
        return PL_ERROR_TRANSFER;
    int status = pl_x86_frontend_open(image, &builder->frontend);
    if (status) return status;
    builder->identities = identities;
    builder->identity_capacity = identity_capacity;
    builder->identity_count = 0u;
    builder->hash_slots = hash_slots;
    builder->hash_slot_count = hash_slot_count;
    builder->admissions = 0u;
    builder->shared = 0u;
    builder->probes = 0u;
    builder->maximum_probe = 0u;
    for (pl_u32 index = 0u; index < hash_slot_count; ++index)
        hash_slots[index] = 0u;
    return 0;
}

int pl_transfer_intern(pl_transfer_builder *builder,
                       const pl_x86_instruction *instruction,
                       pl_u32 *rank)
{
    if (!builder || !instruction || !rank || !builder->frontend.image
            || !builder->identities || !builder->hash_slots)
        return PL_ERROR_TRANSFER;
    pl_u64 hash = pl_x86_transfer_hash(instruction);
    pl_u32 mask = builder->hash_slot_count - 1u;
    pl_u32 slot = (pl_u32)(hash ^ (hash >> 32u)) & mask;
    for (pl_u32 probe = 1u; probe <= builder->hash_slot_count; ++probe) {
        ++builder->probes;
        if (probe > builder->maximum_probe) builder->maximum_probe = probe;
        pl_u32 encoded = builder->hash_slots[slot];
        if (!encoded) {
            if (builder->identity_count >= builder->identity_capacity)
                return PL_ERROR_TRANSFER_CAPACITY;
            pl_u32 fresh = builder->identity_count++;
            builder->identities[fresh].hash = hash;
            builder->identities[fresh].representative = instruction->rip;
            builder->hash_slots[slot] = fresh + 1u;
            ++builder->admissions;
            *rank = fresh;
            return 0;
        }
        pl_u32 candidate = encoded - 1u;
        if (candidate >= builder->identity_count)
            return PL_ERROR_TRANSFER;
        const pl_transfer_identity *identity =
            &builder->identities[candidate];
        if (identity->hash == hash) {
            pl_x86_instruction representative;
            int status = pl_x86_frontend_decode(
                &builder->frontend, identity->representative,
                &representative);
            if (status) return status;
            if (pl_x86_transfer_equal(instruction, &representative)) {
                ++builder->admissions;
                ++builder->shared;
                *rank = candidate;
                return 0;
            }
        }
        slot = (slot + 1u) & mask;
    }
    return PL_ERROR_TRANSFER_CAPACITY;
}

int pl_transfer_rank_instruction(const pl_x86_instruction *instruction,
                                 void *context, pl_u32 *rank)
{
    return pl_transfer_intern(context, instruction, rank);
}

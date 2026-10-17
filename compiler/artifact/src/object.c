#include <artifact/object.h>

static int digest_nonzero(const pl_u8 digest[PL_SHA256_BYTES])
{
    pl_u32 index, value = 0u;
    for (index = 0u; index < PL_SHA256_BYTES; ++index) value |= digest[index];
    return value != 0u;
}

int artifact_object_validate(const artifact_object *object)
{
    return object && object->bytes && object->kind && object->version
        && digest_nonzero(object->digest);
}

int artifact_object_matches(const artifact_object *object,
                            const pl_u8 *bytes, pl_u64 length)
{
    pl_u8 digest[PL_SHA256_BYTES];
    pl_u32 index, difference = 0u;
    if (!artifact_object_validate(object) || !bytes
            || length != object->bytes)
        return 0;
    pl_sha256_digest(bytes, length, digest);
    for (index = 0u; index < PL_SHA256_BYTES; ++index)
        difference |= digest[index] ^ object->digest[index];
    return difference == 0u;
}

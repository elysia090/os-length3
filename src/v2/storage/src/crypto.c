#include <storage/crypto.h>

int storage_crypto_nonce(pl_u64 group, pl_u32 slot,
                         pl_u8 nonce[STORAGE_NONCE_BYTES])
{
    pl_u32 index;
    if (!nonce) return 0;
    for (index = 0u; index < 8u; ++index)
        nonce[index] = (pl_u8)(group >> (index * 8u));
    for (index = 0u; index < 4u; ++index)
        nonce[8u + index] = (pl_u8)(slot >> (index * 8u));
    return 1;
}

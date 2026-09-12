/* AEAD boundary for immutable shard rows; storage tiers remain untrusted. */

#ifndef STORAGE_CRYPTO_H
#define STORAGE_CRYPTO_H

#include <support/types.h>

#define STORAGE_SALT_BYTES 32u
#define STORAGE_NONCE_BYTES 12u
#define STORAGE_TAG_BYTES 16u

typedef struct {
    pl_u8 salt[STORAGE_SALT_BYTES];
    pl_u32 protocol_version;
    pl_u32 algorithm;
    pl_u64 group;
    pl_u32 slot;
    pl_u32 object_class;
} storage_crypto_context;

/* (group, slot) has one injective 96-bit spelling. */
int storage_crypto_nonce(pl_u64 group, pl_u32 slot,
                         pl_u8 nonce[STORAGE_NONCE_BYTES]);

#endif /* STORAGE_CRYPTO_H */

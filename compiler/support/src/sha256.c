#include <support/sha256.h>

static const pl_u32 constants[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static pl_u32 rotate(pl_u32 value, pl_u32 count)
{
    return (value >> count) | (value << (32u - count));
}

static pl_u32 read_big_u32(const pl_u8 *source)
{
    return ((pl_u32)source[0] << 24u) | ((pl_u32)source[1] << 16u)
         | ((pl_u32)source[2] << 8u) | (pl_u32)source[3];
}

static void write_big_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)(value >> 24u);
    target[1] = (pl_u8)(value >> 16u);
    target[2] = (pl_u8)(value >> 8u);
    target[3] = (pl_u8)value;
}

static void compress(pl_sha256 *state, const pl_u8 block[64])
{
    pl_u32 words[64];
    for (pl_u32 index = 0; index < 16u; ++index)
        words[index] = read_big_u32(block + index * 4u);
    for (pl_u32 index = 16u; index < 64u; ++index) {
        pl_u32 left = words[index - 15u];
        pl_u32 right = words[index - 2u];
        pl_u32 sigma0 = rotate(left, 7u) ^ rotate(left, 18u) ^ (left >> 3u);
        pl_u32 sigma1 = rotate(right, 17u) ^ rotate(right, 19u)
                      ^ (right >> 10u);
        words[index] = words[index - 16u] + sigma0
                     + words[index - 7u] + sigma1;
    }

    pl_u32 a = state->state[0], b = state->state[1];
    pl_u32 c = state->state[2], d = state->state[3];
    pl_u32 e = state->state[4], f = state->state[5];
    pl_u32 g = state->state[6], h = state->state[7];
    for (pl_u32 index = 0; index < 64u; ++index) {
        pl_u32 sum1 = rotate(e, 6u) ^ rotate(e, 11u) ^ rotate(e, 25u);
        pl_u32 choose = (e & f) ^ (~e & g);
        pl_u32 first = h + sum1 + choose + constants[index] + words[index];
        pl_u32 sum0 = rotate(a, 2u) ^ rotate(a, 13u) ^ rotate(a, 22u);
        pl_u32 majority = (a & b) ^ (a & c) ^ (b & c);
        pl_u32 second = sum0 + majority;
        h = g; g = f; f = e; e = d + first;
        d = c; c = b; b = a; a = first + second;
    }
    state->state[0] += a; state->state[1] += b;
    state->state[2] += c; state->state[3] += d;
    state->state[4] += e; state->state[5] += f;
    state->state[6] += g; state->state[7] += h;
}

void pl_sha256_open(pl_sha256 *state)
{
    if (!state) return;
    const pl_u32 initial[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    for (pl_u32 index = 0; index < 8u; ++index)
        state->state[index] = initial[index];
    state->bytes = 0u;
    state->buffered = 0u;
}

void pl_sha256_write(pl_sha256 *state, const pl_u8 *bytes, pl_u64 length)
{
    if (!state || (!bytes && length)) return;
    state->bytes += length;
    while (length) {
        pl_u32 room = PL_SHA256_BLOCK_BYTES - state->buffered;
        pl_u32 count = length < room ? (pl_u32)length : room;
        for (pl_u32 index = 0; index < count; ++index)
            state->block[state->buffered + index] = bytes[index];
        state->buffered += count;
        bytes += count;
        length -= count;
        if (state->buffered == PL_SHA256_BLOCK_BYTES) {
            compress(state, state->block);
            state->buffered = 0u;
        }
    }
}

void pl_sha256_close(pl_sha256 *state, pl_u8 digest[PL_SHA256_BYTES])
{
    if (!state || !digest) return;
    pl_u64 bits = state->bytes << 3u;
    state->block[state->buffered++] = 0x80u;
    if (state->buffered > 56u) {
        while (state->buffered < 64u) state->block[state->buffered++] = 0u;
        compress(state, state->block);
        state->buffered = 0u;
    }
    while (state->buffered < 56u) state->block[state->buffered++] = 0u;
    for (pl_u32 index = 0; index < 8u; ++index)
        state->block[56u + index] = (pl_u8)(bits >> (56u - index * 8u));
    compress(state, state->block);
    for (pl_u32 index = 0; index < 8u; ++index)
        write_big_u32(digest + index * 4u, state->state[index]);
    state->buffered = 0u;
}

void pl_sha256_digest(const pl_u8 *bytes, pl_u64 length,
                      pl_u8 digest[PL_SHA256_BYTES])
{
    pl_sha256 state;
    pl_sha256_open(&state);
    pl_sha256_write(&state, bytes, length);
    pl_sha256_close(&state, digest);
}

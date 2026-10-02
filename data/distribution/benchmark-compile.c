/* Fixed compiler workload with no host headers or runtime dependencies. */
typedef unsigned long long word_t;

word_t fold_bytes(const unsigned char *data, unsigned count)
{
    word_t sum = 1u;
    word_t weighted = 0u;
    word_t lanes[4] = { 0u, 0u, 0u, 0u };
    for (unsigned index = 0u; index < count; ++index) {
        unsigned byte = data[index];
        sum += byte;
        if (sum >= 65521u) sum -= 65521u;
        weighted += sum;
        if (weighted >= 65521u) weighted -= 65521u;
        lanes[index & 3u] ^= (word_t)byte << ((index & 7u) * 8u);
        lanes[(index + 1u) & 3u] += lanes[index & 3u] ^ weighted;
    }
    return ((weighted << 32u) | sum)
        ^ lanes[0] ^ lanes[1] ^ lanes[2] ^ lanes[3];
}

unsigned classify_bytes(const unsigned char *data, unsigned count)
{
    unsigned groups[4] = { 0u, 0u, 0u, 0u };
    for (unsigned index = 0u; index < count; ++index) {
        unsigned byte = data[index];
        groups[(byte >> 6u) & 3u] += 1u;
        if (byte == 0u) groups[0] += index & 1u;
    }
    return groups[0] + 3u * groups[1] + 5u * groups[2]
        + 7u * groups[3];
}

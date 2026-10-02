/* Freestanding C compiler-generated structure copies, not guest RAM access. */
#include <stddef.h>
void *memcpy(void *destination, const void *source, size_t bytes)
{
    unsigned char *out = destination;
    const unsigned char *in = source;
    for (size_t i = 0u; i < bytes; ++i) out[i] = in[i];
    return destination;
}
void *memset(void *destination, int value, size_t bytes)
{
    unsigned char *out = destination;
    for (size_t i = 0u; i < bytes; ++i) out[i] = (unsigned char)value;
    return destination;
}

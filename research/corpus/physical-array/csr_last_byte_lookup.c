#include <stddef.h>
#include <stdint.h>

typedef uint8_t state_t;
typedef uint16_t history_key_t;

enum { EMPTY_HISTORY_ADDRESS = 256 };

typedef struct {
    const uint8_t *data;
    size_t size;
} byte_span_t;

/* Every nonempty history has the same future as its final byte.  The empty
 * history is represented separately because it has no final byte. */
static inline state_t feed(state_t state, uint8_t byte)
{
    (void)state;
    return byte;
}

static inline uint8_t read_state(state_t state)
{
    return state;
}

static inline uint8_t rank_byte(uint8_t byte)
{
    return byte;
}

static inline uint8_t digit(uint32_t value, unsigned pass)
{
    return (uint8_t)(value >> (pass * 8u));
}

static inline history_key_t history_address(byte_span_t buffer, size_t end)
{
    /* Precondition: end <= buffer.size. */
    return end == 0
        ? EMPTY_HISTORY_ADDRESS
        : read_state(feed(0, buffer.data[end - 1]));
}

static inline history_key_t record_address(
    byte_span_t buffer,
    const uint64_t *offsets,
    size_t record)
{
    return history_address(buffer, (size_t)offsets[record + 1]);
}

/* Strictly increasing CSR offsets prove every record is nonempty.  Substituting
 * that invariant removes the empty-history branch and its extra table slot. */
uint64_t csr_last_byte_lookup(
    const uint64_t *values,
    const uint8_t *data,
    const uint64_t *offsets,
    size_t record)
{
    return values[data[offsets[record + 1] - 1]];
}

/* UINT64_MAX is both the absent value and the identity of minimum.  One table
 * and one conditional therefore disappear from the merge. */
void csr_last_byte_merge_min(uint64_t *dst, const uint64_t *src)
{
    for (size_t i = 0; i < 256; ++i)
        dst[i] = src[i] < dst[i] ? src[i] : dst[i];
}

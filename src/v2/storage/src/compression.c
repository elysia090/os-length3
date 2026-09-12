#include <storage/compression.h>
#include <support/checked.h>

#define DEFLATE_MAX_BITS 15u
#define DEFLATE_LITERAL_SYMBOLS 288u
#define DEFLATE_DISTANCE_SYMBOLS 32u
#define DEFLATE_CODE_SYMBOLS 19u

typedef struct {
    const pl_u8 *bytes;
    pl_u32 bytes_count;
    pl_u32 bit;
} bit_reader;

typedef struct {
    pl_u16 count[DEFLATE_MAX_BITS + 1u];
    pl_u16 symbols[DEFLATE_LITERAL_SYMBOLS];
} huffman;

static int bits(bit_reader *reader, pl_u32 count, pl_u32 *value)
{
    if (!reader || !value || count > 24u
            || reader->bit > reader->bytes_count * 8u
            || count > reader->bytes_count * 8u - reader->bit)
        return PL_ERROR_DEFLATE_RANGE;
    pl_u32 result = 0u;
    for (pl_u32 index = 0u; index < count; ++index) {
        pl_u32 coordinate = reader->bit++;
        result |= ((pl_u32)(reader->bytes[coordinate >> 3u]
                            >> (coordinate & 7u)) & 1u) << index;
    }
    *value = result;
    return 0;
}

/* Construct the canonical symbol ordering used by RFC 1951.  A positive
 * result is the number of unused codes, zero is complete, and a negative
 * result is oversubscribed. */
static int construct(huffman *table, const pl_u8 *lengths, pl_u32 symbols)
{
    if (!table || !lengths || !symbols
            || symbols > DEFLATE_LITERAL_SYMBOLS)
        return -1;
    for (pl_u32 bits_count = 0u; bits_count <= DEFLATE_MAX_BITS;
         ++bits_count)
        table->count[bits_count] = 0u;
    for (pl_u32 symbol = 0u; symbol < symbols; ++symbol) {
        if (lengths[symbol] > DEFLATE_MAX_BITS) return -1;
        ++table->count[lengths[symbol]];
    }
    if (table->count[0] == symbols) return 0;
    int left = 1;
    for (pl_u32 length = 1u; length <= DEFLATE_MAX_BITS; ++length) {
        left <<= 1;
        left -= table->count[length];
        if (left < 0) return left;
    }
    pl_u16 offsets[DEFLATE_MAX_BITS + 1u];
    offsets[1] = 0u;
    for (pl_u32 length = 1u; length < DEFLATE_MAX_BITS; ++length)
        offsets[length + 1u] = (pl_u16)(
            offsets[length] + table->count[length]);
    for (pl_u32 symbol = 0u; symbol < symbols; ++symbol)
        if (lengths[symbol])
            table->symbols[offsets[lengths[symbol]]++] = (pl_u16)symbol;
    return left;
}

/* Deflate transmits each canonical code least-significant bit first.  This
 * recurrence compares the reversed prefix without constructing a 32 KiB
 * lookup table. */
static int decode(bit_reader *reader, const huffman *table, pl_u32 *symbol)
{
    pl_u32 code = 0u, first = 0u, index = 0u;
    for (pl_u32 length = 1u; length <= DEFLATE_MAX_BITS; ++length) {
        pl_u32 lane = 0u;
        if (bits(reader, 1u, &lane)) return PL_ERROR_DEFLATE_RANGE;
        code |= lane;
        pl_u32 count = table->count[length];
        if (code < first + count) {
            *symbol = table->symbols[index + code - first];
            return 0;
        }
        index += count;
        first = (first + count) << 1u;
        code <<= 1u;
    }
    return PL_ERROR_DEFLATE;
}

static int fixed_tables(huffman *literal, huffman *distance)
{
    pl_u8 lengths[DEFLATE_LITERAL_SYMBOLS];
    for (pl_u32 symbol = 0u; symbol <= 143u; ++symbol) lengths[symbol] = 8u;
    for (pl_u32 symbol = 144u; symbol <= 255u; ++symbol) lengths[symbol] = 9u;
    for (pl_u32 symbol = 256u; symbol <= 279u; ++symbol) lengths[symbol] = 7u;
    for (pl_u32 symbol = 280u; symbol < DEFLATE_LITERAL_SYMBOLS; ++symbol)
        lengths[symbol] = 8u;
    int status = construct(literal, lengths, DEFLATE_LITERAL_SYMBOLS);
    for (pl_u32 symbol = 0u; symbol < DEFLATE_DISTANCE_SYMBOLS; ++symbol)
        lengths[symbol] = 5u;
    if (!status)
        status = construct(distance, lengths, DEFLATE_DISTANCE_SYMBOLS);
    return status < 0 ? PL_ERROR_DEFLATE : 0;
}

static int dynamic_tables(bit_reader *reader, huffman *literal,
                          huffman *distance)
{
    static const pl_u8 order[DEFLATE_CODE_SYMBOLS] = {
        16u, 17u, 18u, 0u, 8u, 7u, 9u, 6u, 10u, 5u,
        11u, 4u, 12u, 3u, 13u, 2u, 14u, 1u, 15u,
    };
    pl_u32 raw_literal = 0u, raw_distance = 0u, raw_code = 0u;
    if (bits(reader, 5u, &raw_literal)
            || bits(reader, 5u, &raw_distance)
            || bits(reader, 4u, &raw_code))
        return PL_ERROR_DEFLATE_RANGE;
    pl_u32 literal_symbols = raw_literal + 257u;
    pl_u32 distance_symbols = raw_distance + 1u;
    pl_u32 code_symbols = raw_code + 4u;
    if (literal_symbols > 286u || distance_symbols > 32u)
        return PL_ERROR_DEFLATE;
    pl_u8 code_lengths[DEFLATE_CODE_SYMBOLS] = { 0u };
    for (pl_u32 index = 0u; index < code_symbols; ++index) {
        pl_u32 length = 0u;
        if (bits(reader, 3u, &length)) return PL_ERROR_DEFLATE_RANGE;
        code_lengths[order[index]] = (pl_u8)length;
    }
    huffman code;
    if (construct(&code, code_lengths, DEFLATE_CODE_SYMBOLS) != 0)
        return PL_ERROR_DEFLATE;

    pl_u8 lengths[DEFLATE_LITERAL_SYMBOLS + DEFLATE_DISTANCE_SYMBOLS];
    pl_u32 total = literal_symbols + distance_symbols;
    pl_u32 used = 0u;
    while (used < total) {
        pl_u32 symbol = 0u;
        if (decode(reader, &code, &symbol)) return PL_ERROR_DEFLATE;
        if (symbol <= 15u) {
            lengths[used++] = (pl_u8)symbol;
            continue;
        }
        pl_u32 extra = 0u, repeat = 0u;
        pl_u8 value = 0u;
        if (symbol == 16u) {
            if (!used || bits(reader, 2u, &extra))
                return PL_ERROR_DEFLATE;
            repeat = extra + 3u;
            value = lengths[used - 1u];
        } else if (symbol == 17u) {
            if (bits(reader, 3u, &extra)) return PL_ERROR_DEFLATE_RANGE;
            repeat = extra + 3u;
        } else if (symbol == 18u) {
            if (bits(reader, 7u, &extra)) return PL_ERROR_DEFLATE_RANGE;
            repeat = extra + 11u;
        } else {
            return PL_ERROR_DEFLATE;
        }
        if (repeat > total - used) return PL_ERROR_DEFLATE;
        while (repeat--) lengths[used++] = value;
    }
    if (!lengths[256u]) return PL_ERROR_DEFLATE;
    int literal_left = construct(literal, lengths, literal_symbols);
    int distance_left = construct(
        distance, lengths + literal_symbols, distance_symbols);
    if (literal_left < 0 || distance_left < 0
            || (literal_left && literal_symbols - literal->count[0] != 1u)
            || (distance_left
                && distance_symbols - distance->count[0] != 1u))
        return PL_ERROR_DEFLATE;
    return 0;
}

static int compressed_block(bit_reader *reader, const huffman *literal,
                            const huffman *distance,
                            pl_u8 *target, pl_u32 target_bytes,
                            pl_u32 *written)
{
    static const pl_u16 length_base[29] = {
        3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 11u, 13u, 15u,
        17u, 19u, 23u, 27u, 31u, 35u, 43u, 51u, 59u, 67u,
        83u, 99u, 115u, 131u, 163u, 195u, 227u, 258u,
    };
    static const pl_u8 length_extra[29] = {
        0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u,
        1u, 1u, 1u, 1u, 2u, 2u, 2u, 2u,
        3u, 3u, 3u, 3u, 4u, 4u, 4u, 4u,
        5u, 5u, 5u, 5u, 0u,
    };
    static const pl_u16 distance_base[30] = {
        1u, 2u, 3u, 4u, 5u, 7u, 9u, 13u, 17u, 25u,
        33u, 49u, 65u, 97u, 129u, 193u, 257u, 385u, 513u, 769u,
        1025u, 1537u, 2049u, 3073u, 4097u, 6145u, 8193u, 12289u,
        16385u, 24577u,
    };
    static const pl_u8 distance_extra[30] = {
        0u, 0u, 0u, 0u, 1u, 1u, 2u, 2u, 3u, 3u,
        4u, 4u, 5u, 5u, 6u, 6u, 7u, 7u, 8u, 8u,
        9u, 9u, 10u, 10u, 11u, 11u, 12u, 12u, 13u, 13u,
    };
    for (;;) {
        pl_u32 symbol = 0u;
        int status = decode(reader, literal, &symbol);
        if (status) return status;
        if (symbol < 256u) {
            if (*written == target_bytes) return PL_ERROR_DEFLATE_RANGE;
            target[(*written)++] = (pl_u8)symbol;
            continue;
        }
        if (symbol == 256u) return 0;
        if (symbol < 257u || symbol > 285u) return PL_ERROR_DEFLATE;
        pl_u32 length_rank = symbol - 257u;
        pl_u32 extra = 0u;
        if (bits(reader, length_extra[length_rank], &extra))
            return PL_ERROR_DEFLATE_RANGE;
        pl_u32 length = length_base[length_rank] + extra;
        pl_u32 distance_symbol = 0u;
        if (decode(reader, distance, &distance_symbol))
            return PL_ERROR_DEFLATE;
        if (distance_symbol >= 30u) return PL_ERROR_DEFLATE;
        if (bits(reader, distance_extra[distance_symbol], &extra))
            return PL_ERROR_DEFLATE_RANGE;
        pl_u32 back = distance_base[distance_symbol] + extra;
        if (!back || back > *written || length > target_bytes - *written)
            return PL_ERROR_DEFLATE_RANGE;
        for (pl_u32 index = 0u; index < length; ++index) {
            target[*written] = target[*written - back];
            ++*written;
        }
    }
}

static int stored_block(bit_reader *reader, pl_u8 *target,
                        pl_u32 target_bytes, pl_u32 *written)
{
    reader->bit = (reader->bit + 7u) & ~7u;
    pl_u32 byte = reader->bit >> 3u;
    if (byte > reader->bytes_count || reader->bytes_count - byte < 4u)
        return PL_ERROR_DEFLATE_RANGE;
    pl_u32 length = pl_read_u16(reader->bytes + byte);
    pl_u32 complement = pl_read_u16(reader->bytes + byte + 2u);
    if ((length ^ 0xffffu) != complement
            || length > reader->bytes_count - byte - 4u
            || length > target_bytes - *written)
        return PL_ERROR_DEFLATE_RANGE;
    for (pl_u32 index = 0u; index < length; ++index)
        target[(*written)++] = reader->bytes[byte + 4u + index];
    reader->bit = (byte + 4u + length) * 8u;
    return 0;
}

static pl_u32 adler32(const pl_u8 *bytes, pl_u32 length)
{
    pl_u32 low = 1u, high = 0u;
    for (pl_u32 index = 0u; index < length; ++index) {
        low += bytes[index];
        if (low >= 65521u) low -= 65521u;
        high += low;
        if (high >= 65521u) high -= 65521u;
    }
    return (high << 16u) | low;
}

int pl_deflate_zlib(void *context,
                    const pl_u8 *source, pl_u32 source_bytes,
                    pl_u8 *target, pl_u32 target_bytes)
{
    (void)context;
    if (!source || !target || source_bytes < 6u)
        return PL_ERROR_DEFLATE_RANGE;
    pl_u32 header = ((pl_u32)source[0] << 8u) | source[1];
    if ((source[0] & 0x0fu) != 8u || (source[0] >> 4u) > 7u
            || header % 31u || (source[1] & 0x20u))
        return PL_ERROR_DEFLATE;
    bit_reader reader = { source + 2u, source_bytes - 6u, 0u };
    pl_u32 written = 0u;
    int final = 0;
    while (!final) {
        pl_u32 final_bit = 0u, kind = 0u;
        if (bits(&reader, 1u, &final_bit) || bits(&reader, 2u, &kind))
            return PL_ERROR_DEFLATE_RANGE;
        final = final_bit != 0u;
        int status = 0;
        if (!kind) {
            status = stored_block(&reader, target, target_bytes, &written);
        } else if (kind == 1u || kind == 2u) {
            huffman literal, distance;
            status = kind == 1u
                   ? fixed_tables(&literal, &distance)
                   : dynamic_tables(&reader, &literal, &distance);
            if (!status)
                status = compressed_block(
                    &reader, &literal, &distance,
                    target, target_bytes, &written);
        } else {
            status = PL_ERROR_DEFLATE;
        }
        if (status) return status;
    }
    if ((reader.bit & 7u)
            && (reader.bytes[reader.bit >> 3u] >> (reader.bit & 7u)))
        return PL_ERROR_DEFLATE;
    reader.bit = (reader.bit + 7u) & ~7u;
    if (reader.bit / 8u != reader.bytes_count || written != target_bytes)
        return PL_ERROR_DEFLATE_RANGE;
    pl_u32 expected = ((pl_u32)source[source_bytes - 4u] << 24u)
                    | ((pl_u32)source[source_bytes - 3u] << 16u)
                    | ((pl_u32)source[source_bytes - 2u] << 8u)
                    | source[source_bytes - 1u];
    return adler32(target, target_bytes) == expected
         ? 0 : PL_ERROR_DEFLATE;
}

typedef struct {
    pl_u8 *bytes;
    pl_u32 capacity;
    pl_u32 bit;
} bit_writer;

static int put_bits(bit_writer *writer, pl_u32 value, pl_u32 count)
{
    if (!writer || count > 24u || writer->bit > writer->capacity * 8u
            || count > writer->capacity * 8u - writer->bit)
        return PL_ERROR_DEFLATE_RANGE;
    for (pl_u32 index = 0u; index < count; ++index) {
        pl_u32 coordinate = writer->bit++;
        writer->bytes[coordinate >> 3u] |=
            (pl_u8)(((value >> index) & 1u) << (coordinate & 7u));
    }
    return 0;
}

static pl_u32 reverse_bits(pl_u32 value, pl_u32 count)
{
    pl_u32 reversed = 0u;
    while (count--) {
        reversed = (reversed << 1u) | (value & 1u);
        value >>= 1u;
    }
    return reversed;
}

static int fixed_symbol(bit_writer *writer, pl_u32 symbol)
{
    pl_u32 code, count;
    if (symbol <= 143u) {
        code = 0x30u + symbol;
        count = 8u;
    } else if (symbol <= 255u) {
        code = 0x190u + symbol - 144u;
        count = 9u;
    } else if (symbol <= 279u) {
        code = symbol - 256u;
        count = 7u;
    } else if (symbol <= 287u) {
        code = 0xc0u + symbol - 280u;
        count = 8u;
    } else {
        return PL_ERROR_DEFLATE;
    }
    return put_bits(writer, reverse_bits(code, count), count);
}

static int fixed_match(bit_writer *writer, pl_u32 length, pl_u32 distance)
{
    static const pl_u16 length_base[29] = {
        3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 11u, 13u, 15u,
        17u, 19u, 23u, 27u, 31u, 35u, 43u, 51u, 59u, 67u,
        83u, 99u, 115u, 131u, 163u, 195u, 227u, 258u,
    };
    static const pl_u8 length_extra[29] = {
        0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u,
        1u, 1u, 1u, 1u, 2u, 2u, 2u, 2u,
        3u, 3u, 3u, 3u, 4u, 4u, 4u, 4u,
        5u, 5u, 5u, 5u, 0u,
    };
    static const pl_u16 distance_base[30] = {
        1u, 2u, 3u, 4u, 5u, 7u, 9u, 13u, 17u, 25u,
        33u, 49u, 65u, 97u, 129u, 193u, 257u, 385u, 513u, 769u,
        1025u, 1537u, 2049u, 3073u, 4097u, 6145u, 8193u, 12289u,
        16385u, 24577u,
    };
    static const pl_u8 distance_extra[30] = {
        0u, 0u, 0u, 0u, 1u, 1u, 2u, 2u, 3u, 3u,
        4u, 4u, 5u, 5u, 6u, 6u, 7u, 7u, 8u, 8u,
        9u, 9u, 10u, 10u, 11u, 11u, 12u, 12u, 13u, 13u,
    };
    if (length < 3u || length > 258u || !distance || distance > 32768u)
        return PL_ERROR_DEFLATE_RANGE;
    pl_u32 length_rank = 0u;
    while (length_rank + 1u < 29u
            && length >= length_base[length_rank + 1u])
        ++length_rank;
    int status = fixed_symbol(writer, 257u + length_rank);
    if (!status && length_extra[length_rank])
        status = put_bits(
            writer, length - length_base[length_rank],
            length_extra[length_rank]);
    pl_u32 distance_rank = 0u;
    while (distance_rank + 1u < 30u
            && distance >= distance_base[distance_rank + 1u])
        ++distance_rank;
    if (!status)
        status = put_bits(writer, reverse_bits(distance_rank, 5u), 5u);
    if (!status && distance_extra[distance_rank])
        status = put_bits(
            writer, distance - distance_base[distance_rank],
            distance_extra[distance_rank]);
    return status;
}

static pl_u32 match_hash(const pl_u8 *source, pl_u32 at)
{
    pl_u32 word = (pl_u32)source[at]
                | (pl_u32)source[at + 1u] << 8u
                | (pl_u32)source[at + 2u] << 16u;
    return (word * 0x1e35a7bdu) >> 20u;
}

int pl_deflate_fixed_zlib(const pl_u8 *source, pl_u32 source_bytes,
                          pl_u8 *target, pl_u32 target_capacity,
                          pl_u32 *written)
{
    enum { HASH_SLOTS = 4096 };
    if (!source || !source_bytes || !target || !written
            || target_capacity < 7u)
        return PL_ERROR_DEFLATE_RANGE;
    for (pl_u32 index = 0u; index < target_capacity; ++index)
        target[index] = 0u;
    target[0] = 0x78u;
    target[1] = 0x01u;
    bit_writer writer = { target + 2u, target_capacity - 6u, 0u };
    int status = put_bits(&writer, 3u, 3u); /* final, fixed-Huffman block */
    pl_i32 head[HASH_SLOTS];
    for (pl_u32 index = 0u; index < HASH_SLOTS; ++index) head[index] = -1;

    for (pl_u32 at = 0u; !status && at < source_bytes;) {
        pl_u32 length = 0u, distance = 0u;
        if (at + 2u < source_bytes) {
            pl_u32 slot = match_hash(source, at);
            pl_i32 previous = head[slot];
            head[slot] = (pl_i32)at;
            if (previous >= 0 && at - (pl_u32)previous <= 32768u
                    && source[previous] == source[at]
                    && source[previous + 1] == source[at + 1u]
                    && source[previous + 2] == source[at + 2u]) {
                pl_u32 limit = source_bytes - at;
                if (limit > 258u) limit = 258u;
                length = 3u;
                while (length < limit
                        && source[(pl_u32)previous + length]
                           == source[at + length])
                    ++length;
                distance = at - (pl_u32)previous;
            }
        }
        if (length >= 3u) {
            status = fixed_match(&writer, length, distance);
            for (pl_u32 step = 1u; step < length; ++step)
                if (at + step + 2u < source_bytes)
                    head[match_hash(source, at + step)] =
                        (pl_i32)(at + step);
            at += length;
        } else {
            status = fixed_symbol(&writer, source[at++]);
        }
    }
    if (!status) status = fixed_symbol(&writer, 256u);
    pl_u32 payload_bytes = (writer.bit + 7u) / 8u;
    if (!status && payload_bytes > target_capacity - 6u)
        status = PL_ERROR_DEFLATE_RANGE;
    pl_u32 total = 2u + payload_bytes + 4u;
    if (!status && total > target_capacity) status = PL_ERROR_DEFLATE_RANGE;
    pl_u32 checksum = adler32(source, source_bytes);
    if (!status) {
        target[total - 4u] = (pl_u8)(checksum >> 24u);
        target[total - 3u] = (pl_u8)(checksum >> 16u);
        target[total - 2u] = (pl_u8)(checksum >> 8u);
        target[total - 1u] = (pl_u8)checksum;
        *written = total;
    }
    return status;
}

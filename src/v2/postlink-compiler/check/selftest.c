/* Self-test for the canonical record and continuation codecs.
 *
 *   selftest             run the assertions
 *   selftest --vectors   additionally print encoded rows for check/parity
 *
 * The vector stream is what proves the C codec against the Python writer that
 * still produces artifacts today; see check/format_parity.py.
 */

#include <stdio.h>
#include <string.h>

#include <postlink/continuation.h>

static int failures;

static void fail(const char *what, long long left, long long right)
{
    fprintf(stderr, "FAIL %s: %lld != %lld\n", what, left, right);
    failures += 1;
}

#define CHECK(what, left, right)                                        \
    do {                                                                \
        long long l_ = (long long)(left), r_ = (long long)(right);      \
        if (l_ != r_) fail(what, l_, r_);                               \
    } while (0)

/* Values chosen to land on every residual width boundary and on the
 * equality tags, in both signs. */
static const pl_u64 INTERESTING[] = {
    0ull, 1ull, 2ull, 127ull, 128ull, 129ull,
    32767ull, 32768ull, 2147483647ull, 2147483648ull,
    (pl_u64)-1ll, (pl_u64)-128ll, (pl_u64)-129ll,
    (pl_u64)-32768ll, (pl_u64)-32769ll,
    (pl_u64)-2147483648ll, (pl_u64)-2147483649ll,
    0x0123456789abcdefull,
};
#define INTERESTING_COUNT (sizeof INTERESTING / sizeof INTERESTING[0])

static void check_continuation_roundtrip(int emit_vectors)
{
    pl_u8 buffer[PL_CONTINUATION_MAX_BYTES];
    for (pl_u32 control = 0; control <= (pl_u32)PL_CONTROL_MAX; ++control) {
        for (unsigned a = 0; a < INTERESTING_COUNT; ++a) {
            for (unsigned b = 0; b < INTERESTING_COUNT; ++b) {
                pl_continuation row = {
                    control,
                    { INTERESTING[a], INTERESTING[b],
                      INTERESTING[(a + b) % INTERESTING_COUNT],
                      INTERESTING[(a + 2 * b) % INTERESTING_COUNT] },
                };
                pl_u32 written = 0;
                int status = pl_continuation_encode(
                    &row, buffer, sizeof buffer, &written);
                CHECK("encode status", status, 0);
                if (status) continue;

                pl_continuation decoded;
                status = pl_continuation_decode(buffer, written, &decoded);
                CHECK("decode status", status, 0);
                if (status) continue;
                CHECK("control", decoded.control, row.control);
                for (pl_u32 i = 0; i < PL_CONTINUATION_FIELDS; ++i)
                    CHECK("field", decoded.field[i], row.field[i]);

                if (emit_vectors) {
                    printf("%u", control);
                    for (pl_u32 i = 0; i < PL_CONTINUATION_FIELDS; ++i)
                        printf(" %llu",
                               (unsigned long long)row.field[i]);
                    printf(" ");
                    for (pl_u32 i = 0; i < written; ++i)
                        printf("%02x", buffer[i]);
                    printf("\n");
                }
            }
        }
    }
}

/* An artifact must not be able to spell one continuation two ways. */
static void check_continuation_canonicality(void)
{
    /* Field 1 equals field 0, so tag 1 is the only legal spelling; writing
     * the value out longhand must be rejected. */
    pl_u8 longhand[] = { PL_CONTROL_BRANCH, 0, 0, 0x2a, 0x2a };
    pl_u32 tags = PL_TAG_SIGNED_8 | (PL_TAG_SIGNED_8 << 3);
    longhand[1] = (pl_u8)tags;
    longhand[2] = (pl_u8)(tags >> 8);
    pl_continuation decoded;
    CHECK("non-minimal equality is rejected",
          pl_continuation_decode(longhand, sizeof longhand, &decoded),
          PL_ERROR_CANONICAL);

    /* A wide residual holding a value that fits in a narrow one. */
    pl_u8 wide[] = { PL_CONTROL_BRANCH, PL_TAG_SIGNED_16, 0, 0x01, 0x00 };
    CHECK("non-minimal width is rejected",
          pl_continuation_decode(wide, sizeof wide, &decoded),
          PL_ERROR_CANONICAL);

    /* Trailing bytes past the declared fields. */
    pl_u8 trailing[] = { PL_CONTROL_BRANCH, PL_TAG_SIGNED_8, 0, 0x01, 0xff };
    CHECK("trailing bytes are rejected",
          pl_continuation_decode(trailing, sizeof trailing, &decoded),
          PL_ERROR_CANONICAL);

    /* Tag bits above the four fields. */
    pl_u8 reserved[] = { PL_CONTROL_BRANCH, 0, 0x10 };
    CHECK("reserved tag bits are rejected",
          pl_continuation_decode(reserved, sizeof reserved, &decoded),
          PL_ERROR_CONTINUATION);

    /* Control above the known maximum. */
    pl_u8 control[] = { PL_CONTROL_MAX + 1, 0, 0 };
    CHECK("unknown control is rejected",
          pl_continuation_decode(control, sizeof control, &decoded),
          PL_ERROR_CONTINUATION);
}

static void check_continuation_projection(void)
{
    const pl_u64 rip = 0xffffffff81000000ull;
    for (pl_u32 control = 0; control <= (pl_u32)PL_CONTROL_MAX; ++control) {
        pl_continuation absolute = {
            control,
            { rip + 16u, rip + 0x40u, control == PL_CONTROL_CONDITIONAL
                                          ? rip + 0x80u : 0u, 7u },
        };
        pl_continuation relative, again;
        pl_continuation_project(rip, &absolute, &relative);
        pl_continuation_instantiate(rip, &relative, &again);
        CHECK("projection control", again.control, absolute.control);
        for (pl_u32 i = 0; i < PL_CONTINUATION_FIELDS; ++i)
            CHECK("projection field", again.field[i], absolute.field[i]);

        /* The boundary is always relative, so a nearby boundary must
         * compress to a one-byte residual. */
        CHECK("boundary is a displacement", relative.field[PL_FIELD_BOUNDARY],
              16u);
    }

    /* A zero second target means "no target" and must stay zero rather than
     * becoming -rip. */
    pl_continuation none = { PL_CONTROL_CONDITIONAL,
                             { rip, rip + 0x20u, 0u, 0u } };
    pl_continuation projected;
    pl_continuation_project(rip, &none, &projected);
    CHECK("absent target stays zero", projected.field[PL_FIELD_SECOND], 0);
}

/* Build a minimal well-formed version-3 record with one proof entry. */
static pl_u32 build_record(pl_u8 *record, pl_u32 guard_length,
                           pl_u32 parameter_bytes, pl_u32 template_bytes)
{
    memset(record, 0, PL_BLOCK_HEADER_BYTES);
    memcpy(record, PL_BLOCK_MAGIC, 4);
    pl_write_u16(record + PL_BLOCK_OFF_VERSION, PL_BLOCK_VERSION_TEMPLATE);
    pl_write_u16(record + PL_BLOCK_OFF_HEADER_BYTES, PL_BLOCK_HEADER_BYTES);
    pl_write_u64(record + PL_BLOCK_OFF_RIP, 0xffffffff81000000ull);
    pl_write_u64(record + PL_BLOCK_OFF_BOUNDARY_RIP, 0xffffffff81000010ull);
    pl_write_u32(record + PL_BLOCK_OFF_STEP_BYTES, template_bytes);
    pl_write_u32(record + PL_BLOCK_OFF_CONTROL, PL_CONTROL_BRANCH);
    pl_write_u32(record + PL_BLOCK_OFF_PARAMETER_BYTES, parameter_bytes);
    pl_write_u32(record + PL_BLOCK_OFF_TEMPLATE_BYTES, template_bytes);

    pl_u8 *guard = record + PL_BLOCK_HEADER_BYTES;
    pl_u32 guard_bytes = 0;
    if (guard_length) {
        pl_write_u16(guard, 1u);
        pl_write_u64(guard + 2u, 0xffffffff81000000ull);
        pl_write_u16(guard + 10u, guard_length);
        memset(guard + 12u, 0x90, guard_length);
        guard_bytes = PL_GUARD_COUNT_BYTES + PL_GUARD_ENTRY_BYTES
                    + guard_length;
    }
    return PL_BLOCK_HEADER_BYTES + guard_bytes + parameter_bytes
         + template_bytes;
}

static void check_block_records(void)
{
    pl_u8 record[512];
    pl_block_header header;

    pl_u32 bytes = build_record(record, 4u, 8u, 32u);
    CHECK("well-formed record", pl_block_parse(record, bytes, &header), 0);
    CHECK("version", header.version, PL_BLOCK_VERSION_TEMPLATE);
    CHECK("rip", header.rip, 0xffffffff81000000ull);
    CHECK("guard extent", header.guard_bytes, 16u);
    CHECK("parameter extent", header.parameter_bytes, 8u);
    CHECK("template extent", header.template_bytes, 32u);
    CHECK("extents tile the record",
          header.guard_bytes + header.parameter_bytes + header.template_bytes,
          bytes - PL_BLOCK_HEADER_BYTES);

    CHECK("short record", pl_block_parse(record, 16u, &header),
          PL_ERROR_SHORT);

    record[0] = 'Y';
    CHECK("wrong magic", pl_block_parse(record, bytes, &header),
          PL_ERROR_MAGIC);
    record[0] = 'X';

    pl_write_u16(record + PL_BLOCK_OFF_VERSION, 4u);
    CHECK("unknown version", pl_block_parse(record, bytes, &header),
          PL_ERROR_VERSION);
    pl_write_u16(record + PL_BLOCK_OFF_VERSION, PL_BLOCK_VERSION_TEMPLATE);

    pl_write_u16(record + PL_BLOCK_OFF_HEADER_BYTES, 48u);
    CHECK("wrong header extent", pl_block_parse(record, bytes, &header),
          PL_ERROR_HEADER);
    pl_write_u16(record + PL_BLOCK_OFF_HEADER_BYTES, PL_BLOCK_HEADER_BYTES);

    pl_write_u32(record + PL_BLOCK_OFF_CONTROL, PL_CONTROL_MAX + 1u);
    CHECK("unknown control", pl_block_parse(record, bytes, &header),
          PL_ERROR_CONTROL);
    pl_write_u32(record + PL_BLOCK_OFF_CONTROL, PL_CONTROL_BRANCH);

    /* A template extent past the record must not wrap the guard subtraction
     * into a huge unsigned value. */
    pl_write_u32(record + PL_BLOCK_OFF_TEMPLATE_BYTES, 0xffffff00u);
    CHECK("template extent past the record",
          pl_block_parse(record, bytes, &header), PL_ERROR_EXTENT);
    pl_write_u32(record + PL_BLOCK_OFF_TEMPLATE_BYTES, 32u);

    pl_write_u32(record + PL_BLOCK_OFF_PARAMETER_BYTES, 0xffffff00u);
    CHECK("parameter extent past the record",
          pl_block_parse(record, bytes, &header), PL_ERROR_EXTENT);
    pl_write_u32(record + PL_BLOCK_OFF_PARAMETER_BYTES, 8u);

    pl_write_u32(record + PL_BLOCK_OFF_STEP_BYTES, 0u);
    CHECK("zero step extent", pl_block_parse(record, bytes, &header),
          PL_ERROR_EXTENT);
    pl_write_u32(record + PL_BLOCK_OFF_STEP_BYTES, 32u);

    /* A proof entry claiming more bytes than the guard extent holds. */
    bytes = build_record(record, 4u, 0u, 32u);
    pl_write_u16(record + PL_BLOCK_HEADER_BYTES + 10u, 64u);
    CHECK("proof entry past the guard extent",
          pl_block_parse(record, bytes, &header), PL_ERROR_GUARD);

    /* A version-2 record must carry a proof. */
    bytes = build_record(record, 0u, 0u, 32u);
    pl_write_u16(record + PL_BLOCK_OFF_VERSION, PL_BLOCK_VERSION_PROOF);
    CHECK("version 2 without a proof",
          pl_block_parse(record, bytes, &header), PL_ERROR_EXTENT);

    /* A version-1 record must carry neither proof nor parameters. */
    bytes = build_record(record, 4u, 0u, 32u);
    pl_write_u16(record + PL_BLOCK_OFF_VERSION, PL_BLOCK_VERSION_STEP);
    CHECK("version 1 with a proof",
          pl_block_parse(record, bytes, &header), PL_ERROR_EXTENT);
}

int main(int argc, char **argv)
{
    int emit_vectors = argc > 1 && !strcmp(argv[1], "--vectors");
    check_continuation_roundtrip(emit_vectors);
    check_continuation_canonicality();
    check_continuation_projection();
    check_block_records();
    if (failures) {
        fprintf(stderr, "%d assertion(s) failed\n", failures);
        return 1;
    }
    if (!emit_vectors) fprintf(stderr, "postlink selftest: ok\n");
    return 0;
}

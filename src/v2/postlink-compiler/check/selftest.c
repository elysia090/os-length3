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

#include <postlink/affine.h>
#include <postlink/block.h>
#include <postlink/boot.h>
#include <postlink/closure.h>
#include <postlink/continuation.h>
#include <postlink/delivery.h>
#include <postlink/deflate.h>
#include <postlink/elf.h>
#include <postlink/entrymap.h>
#include <postlink/executable.h>
#include <postlink/index.h>
#include <postlink/instantiation.h>
#include <postlink/physical.h>
#include <postlink/projection.h>
#include <postlink/residual.h>
#include <postlink/semantic.h>
#include <postlink/sha256.h>
#include <postlink/transfer.h>
#include <postlink/wasm.h>
#include <postlink/x86.h>

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


/* Schema 6: the chain field, and that it cannot be spelled two ways. */
static void check_chained_roundtrip(void)
{
    static const pl_i64 DELTAS[] = {
        1, 0, -1, 2, 127, 128, -128, -129, 32767, -32768, 32768, -32769,
        2147483647, -2147483648LL, 222078, -222078,
    };
    pl_u8 buffer[PL_CONTINUATION_CHAINED_MAX_BYTES];
    for (pl_u32 control = 0; control <= (pl_u32)PL_CONTROL_MAX; ++control) {
        for (unsigned a = 0; a < INTERESTING_COUNT; ++a) {
            for (unsigned d = 0;
                 d < sizeof DELTAS / sizeof DELTAS[0]; ++d) {
                for (int chainable = 0; chainable < 2; ++chainable) {
                    pl_continuation row = {
                        control,
                        { INTERESTING[a], INTERESTING[(a + 3) % INTERESTING_COUNT],
                          INTERESTING[(a + 5) % INTERESTING_COUNT],
                          INTERESTING[(a + 7) % INTERESTING_COUNT] },
                    };
                    pl_u32 written = 0;
                    int status = pl_continuation_encode_chained(
                        &row, chainable, DELTAS[d], buffer, sizeof buffer,
                        &written);
                    CHECK("chained encode", status, 0);
                    if (status) continue;

                    pl_continuation decoded;
                    int back_chainable = -1;
                    pl_i64 back_delta = 0;
                    status = pl_continuation_decode_chained(
                        buffer, written, &decoded, &back_chainable,
                        &back_delta);
                    CHECK("chained decode", status, 0);
                    if (status) continue;
                    CHECK("chained control", decoded.control, row.control);
                    for (pl_u32 i = 0; i < PL_CONTINUATION_FIELDS; ++i)
                        CHECK("chained field", decoded.field[i], row.field[i]);
                    /* A zero delta is a self-loop -- a block branching to
                     * its own coordinate -- and must stay distinguishable
                     * from an unfoldable dispatch. */
                    CHECK("chainability survives", back_chainable, chainable);
                    CHECK("delta survives", back_delta,
                          chainable ? DELTAS[d] : 0);
                }
            }
        }
    }

    /* Fall-through costs no payload: three bytes total for a bare row. */
    pl_continuation bare = { PL_CONTROL_BRANCH, { 0, 0, 0, 0 } };
    pl_u32 written = 0;
    CHECK("fall-through encodes",
          pl_continuation_encode_chained(&bare, 1, 1, buffer, sizeof buffer,
                                         &written), 0);
    CHECK("fall-through is free", written, PL_CONTINUATION_HEADER_BYTES);

    /* Delta one written longhand must be rejected. */
    pl_u8 longhand[] = { PL_CONTROL_BRANCH, 0, 0, 0x01 };
    pl_u32 tags = PL_TAG_SIGNED_8 << (PL_FIELD_CHAIN * 3);
    longhand[1] = (pl_u8)tags;
    longhand[2] = (pl_u8)(tags >> 8);
    pl_continuation decoded;
    CHECK("longhand fall-through is rejected",
          pl_continuation_decode_chained(longhand, sizeof longhand, &decoded,
                                         0, 0),
          PL_ERROR_CANONICAL);

    /* The chain field cannot name an earlier field. */
    pl_u8 aliased[] = { PL_CONTROL_BRANCH, 0, 0 };
    tags = PL_TAG_FIELD_0 << (PL_FIELD_CHAIN * 3);
    aliased[1] = (pl_u8)tags;
    aliased[2] = (pl_u8)(tags >> 8);
    CHECK("aliased chain tag is rejected",
          pl_continuation_decode_chained(aliased, sizeof aliased, &decoded,
                                         0, 0),
          PL_ERROR_CONTINUATION);

    /* The sixteenth tag bit is reserved. */
    pl_u8 reserved[] = { PL_CONTROL_BRANCH, 0, 0x80 };
    CHECK("reserved chained tag bit is rejected",
          pl_continuation_decode_chained(reserved, sizeof reserved, &decoded,
                                         0, 0),
          PL_ERROR_CONTINUATION);
}

static void check_elf_input(void)
{
    pl_u8 bytes[512] = { 0 };
    bytes[0] = 0x7fu; bytes[1] = 'E'; bytes[2] = 'L'; bytes[3] = 'F';
    bytes[4] = 2u; bytes[5] = 1u; bytes[6] = 1u;
    pl_write_u16(bytes + 16u, PL_ELF_TYPE_EXEC);
    pl_write_u16(bytes + 18u, PL_ELF_MACHINE_X86_64);
    pl_write_u32(bytes + 20u, 1u);
    pl_write_u64(bytes + 24u, 0x400080u);
    pl_write_u64(bytes + 32u, PL_ELF_HEADER_BYTES);
    pl_write_u16(bytes + 52u, PL_ELF_HEADER_BYTES);
    pl_write_u16(bytes + 54u, PL_ELF_PROGRAM_BYTES);
    pl_write_u16(bytes + 56u, 1u);
    pl_write_u64(bytes + 40u, 384u);
    pl_write_u16(bytes + 58u, PL_ELF_SECTION_BYTES);
    pl_write_u16(bytes + 60u, 1u);

    pl_u8 *program = bytes + PL_ELF_HEADER_BYTES;
    pl_write_u32(program, PL_ELF_SEGMENT_LOAD);
    pl_write_u32(program + 4u, PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE);
    pl_write_u64(program + 8u, 0u);
    pl_write_u64(program + 16u, 0x400000u);
    pl_write_u64(program + 24u, 0x100000u);
    pl_write_u64(program + 32u, 256u);
    pl_write_u64(program + 40u, 384u);
    pl_write_u64(program + 48u, 4096u);

    pl_u8 *section_row = bytes + 384u;
    pl_write_u32(section_row + 4u, PL_ELF_SECTION_PROGBITS);
    pl_write_u64(section_row + 8u,
                 PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE);
    pl_write_u64(section_row + 16u, 0x400080u);
    pl_write_u64(section_row + 24u, 128u);
    pl_write_u64(section_row + 32u, 4u);
    pl_write_u64(section_row + 48u, 16u);

    pl_elf_image image;
    CHECK("ELF opens", pl_elf_open(bytes, sizeof bytes, &image), 0);
    CHECK("ELF entry", image.entry, 0x400080u);
    CHECK("ELF program count", image.program_count, 1u);
    CHECK("ELF section count", image.section_count, 1u);
    pl_elf_segment segment;
    CHECK("ELF program opens", pl_elf_program(&image, 0u, &segment), 0);
    CHECK("ELF executable", pl_elf_segment_is_executable(&segment), 1);
    CHECK("ELF file extent", segment.file_bytes, 256u);
    CHECK("ELF memory extent", segment.memory_bytes, 384u);
    pl_elf_section section;
    CHECK("ELF section opens", pl_elf_section_read(&image, 0u, &section), 0);
    CHECK("ELF executable section",
          pl_elf_section_is_executable(&section), 1);
    CHECK("ELF section file extent", section.file_bytes, 4u);

    pl_write_u64(program + 32u, 513u);
    CHECK("ELF rejects file overrun",
          pl_elf_program(&image, 0u, &segment), PL_ERROR_ELF_RANGE);
    pl_write_u64(program + 32u, 256u);
    bytes[5] = 2u;
    CHECK("ELF rejects big endian",
          pl_elf_open(bytes, sizeof bytes, &image), PL_ERROR_ELF);
    bytes[5] = 1u;

    pl_x86_map maps[1];
    pl_x86_image source;
    pl_u32 map_count = 0u;
    CHECK("ELF counts executable maps",
          pl_x86_elf_map_count(&image, &map_count), 0);
    CHECK("ELF executable map count", map_count, 1u);
    CHECK("ELF projects executable maps",
          pl_x86_image_from_elf(
              &image, 0x1000u, 9u, maps, 1u, &source), 0);
    CHECK("ELF projection applies load bias", maps[0].address, 0x401000u);
    CHECK("ELF projection applies entry bias", source.entry, 0x401080u);
    CHECK("ELF projection retains generation", maps[0].generation, 9u);
    CHECK("ELF projects physical load coordinates",
          pl_x86_image_from_elf_coordinates(
              &image, 0x2000u, 10u, PL_X86_ELF_PHYSICAL,
              maps, 1u, &source), 0);
    CHECK("ELF physical projection uses p_paddr",
          maps[0].address, 0x102000u);
    CHECK("ELF physical projection retains linked entry",
          source.entry, 0x402080u);
    pl_x86_map aliases[2];
    CHECK("ELF publishes physical and virtual aliases",
          pl_x86_image_from_elf_aliases(
              &image, 0u, 0u, 11u, aliases, 2u, &source), 0);
    CHECK("ELF distinct aliases remain distinct", source.map_count, 2u);
    CHECK("ELF alias entry chooses the mapped coordinate",
          source.entry, 0x400080u);
    CHECK("ELF physical alias coordinate", aliases[0].address, 0x100000u);
    CHECK("ELF virtual alias coordinate", aliases[1].address, 0x400000u);
    CHECK("ELF projection rejects short map storage",
          pl_x86_image_from_elf(
              &image, 0u, 0u, maps, 0u, &source),
          PL_ERROR_X86_CAPACITY);
}

static int rank_x86_instruction(const pl_x86_instruction *instruction,
                                void *context, pl_u32 *function_rank)
{
    (void)context;
    if (instruction->flow == PL_X86_FLOW_FAULT)
        *function_rank = 0u;
    else if (instruction->family == PL_X86_FAMILY_DIVIDE_UNSIGNED
            || instruction->family == PL_X86_FAMILY_DIVIDE_SIGNED)
        *function_rank = 1u;
    else
        *function_rank = 2u + instruction->flow;
    return 0;
}

static void check_x86_frontend(void)
{
    static const pl_u8 code[] = {
        0x48u, 0x8bu, 0x44u, 0x8fu, 0x10u, /* mov rax,[rdi+rcx*4+16] */
        0x48u, 0xf7u, 0xf1u,               /* div rcx */
        0x75u, 0xfbu,                      /* jnz back to div */
        0xffu, 0xd0u,                      /* call rax */
        0x0fu, 0x0bu,                      /* ud2 */
    };
    static const pl_u8 truncated[] = { 0x0fu };
    static const pl_u8 zero_tail[] = { 0x90u };
    static const pl_u8 overlong[] = {
        0x66u, 0x66u, 0x66u, 0x66u, 0x66u, 0x66u, 0x66u, 0x66u,
        0x66u, 0x66u, 0x66u, 0x66u, 0x66u, 0x66u, 0x66u, 0x90u,
        0x8du, 0xc0u, /* LEA with a register source is architecturally #UD. */
    };
    pl_x86_map maps[4] = {
        { code, 0x400000u, sizeof code, sizeof code,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 3u },
        { truncated, 0x500000u, sizeof truncated, sizeof truncated,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 3u },
        { zero_tail, 0x600000u, sizeof zero_tail, 3u,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 3u },
        { overlong, 0x700000u, sizeof overlong, sizeof overlong,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 3u },
    };
    pl_x86_image image = { maps, 4u, 0u, 0x400000u };
    CHECK("x86 source maps validate", pl_x86_image_validate(&image), 0);

    pl_u8 projection[3];
    pl_u32 projected = 0u;
    CHECK("x86 source reads a sparse zero tail",
          pl_x86_image_read(
              &image, 0x600000u, projection, sizeof projection, &projected),
          0);
    CHECK("x86 sparse tail length", projected, 3u);
    CHECK("x86 sparse tail keeps file byte", projection[0], 0x90u);
    CHECK("x86 sparse tail projects first zero", projection[1], 0u);
    CHECK("x86 sparse tail projects second zero", projection[2], 0u);

    pl_x86_instruction instruction;
    CHECK("x86 decodes indexed load",
          pl_x86_decode(&image, 0x400000u, &instruction), 0);
    CHECK("x86 load is valid", instruction.status, PL_X86_DECODE_VALID);
    CHECK("x86 load length", instruction.length, 5u);
    CHECK("x86 load reads memory",
          !!(instruction.flags & PL_X86_INSTRUCTION_READS_MEMORY), 1);
    CHECK("x86 load keeps two visible operands",
          instruction.visible_operand_count, 2u);
    CHECK("x86 load memory operand",
          instruction.operands[1].kind, PL_X86_OPERAND_MEMORY);
    CHECK("x86 load base is rdi",
          instruction.operands[1].value.memory.base.index, 7u);
    CHECK("x86 load index is rcx",
          instruction.operands[1].value.memory.index.index, 1u);
    CHECK("x86 load scale", instruction.operands[1].value.memory.scale, 4u);
    CHECK("x86 load displacement",
          instruction.operands[1].value.memory.displacement, 16u);

    CHECK("x86 decodes divide cut",
          pl_x86_decode(&image, 0x400005u, &instruction), 0);
    CHECK("x86 classifies unsigned divide", instruction.family,
          PL_X86_FAMILY_DIVIDE_UNSIGNED);
    CHECK("x86 divide retains #DE vector", instruction.trap_vector, 0u);
    CHECK("x86 divide is a precise source cut",
          !!(instruction.flags & PL_X86_INSTRUCTION_PRECISE_CUT), 1);
    CHECK("x86 divide may trap",
          !!(instruction.flags & PL_X86_INSTRUCTION_MAY_TRAP), 1);

    CHECK("x86 decodes conditional edge",
          pl_x86_decode(&image, 0x400008u, &instruction), 0);
    CHECK("x86 conditional flow", instruction.flow,
          PL_X86_FLOW_CONDITIONAL);
    CHECK("x86 conditional direct target", instruction.target, 0x400005u);
    CHECK("x86 conditional retains fallthrough",
          instruction.fallthrough, 0x40000au);
    CHECK("x86 conditional keeps exact proof bytes",
          instruction.source_bytes, 2u);

    pl_x86_map transfer_maps[2] = {
        { code, 0x800000u, sizeof code, sizeof code,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 4u },
        { code, 0x900000u, sizeof code, sizeof code,
          PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 4u },
    };
    pl_x86_image transfer_image = {
        transfer_maps, 2u, 0u, 0x800000u,
    };
    pl_x86_instruction physical_transfer, virtual_transfer;
    CHECK("x86 decodes physical transfer alias",
          pl_x86_decode(
              &transfer_image, 0x800008u, &physical_transfer), 0);
    CHECK("x86 decodes virtual transfer alias",
          pl_x86_decode(
              &transfer_image, 0x900008u, &virtual_transfer), 0);
    CHECK("x86 aliases keep distinct direct proof targets",
          physical_transfer.target != virtual_transfer.target, 1);
    CHECK("x86 aliases share conservative transfer identity",
          pl_x86_transfer_equal(
              &physical_transfer, &virtual_transfer), 1);
    CHECK("x86 alias transfer hashes agree",
          pl_x86_transfer_hash(&physical_transfer),
          pl_x86_transfer_hash(&virtual_transfer));

    pl_transfer_identity transfer_identities[4];
    pl_u32 transfer_slots[8];
    pl_transfer_builder transfer_builder;
    CHECK("x86 transfer interner opens on immutable image",
          pl_transfer_builder_open(
              &transfer_builder, &transfer_image, transfer_identities, 4u,
              transfer_slots, 8u), 0);
    pl_u32 physical_rank = 0xffffffffu;
    pl_u32 virtual_rank = 0xffffffffu;
    CHECK("x86 transfer interner admits physical alias",
          pl_transfer_intern(
              &transfer_builder, &physical_transfer, &physical_rank), 0);
    CHECK("x86 transfer interner admits virtual alias",
          pl_transfer_intern(
              &transfer_builder, &virtual_transfer, &virtual_rank), 0);
    CHECK("x86 transfer aliases receive one dense rank",
          physical_rank, virtual_rank);
    CHECK("x86 transfer aliases retain one identity",
          transfer_builder.identity_count, 1u);
    CHECK("x86 transfer hit is counted as shared",
          transfer_builder.shared, 1u);

    CHECK("x86 decodes indirect call",
          pl_x86_decode(&image, 0x40000au, &instruction), 0);
    CHECK("x86 call flow", instruction.flow, PL_X86_FLOW_CALL);
    CHECK("x86 call is indirect",
          !!(instruction.flags & PL_X86_INSTRUCTION_INDIRECT), 1);

    CHECK("x86 decodes explicit invalid instruction",
          pl_x86_decode(&image, 0x40000cu, &instruction), 0);
    CHECK("x86 ud2 is a fault", instruction.flow, PL_X86_FLOW_FAULT);
    CHECK("x86 ud2 is #UD", instruction.trap_vector, 6u);
    CHECK("x86 ud2 keeps exact source length", instruction.length, 2u);
    pl_x86_instruction explicit_ud = instruction;

    CHECK("x86 totalizes a truncated fetch",
          pl_x86_decode(&image, 0x500000u, &instruction), 0);
    CHECK("x86 truncated status", instruction.status,
          PL_X86_DECODE_FETCH_FAULT);
    CHECK("x86 truncated fetch is #PF", instruction.trap_vector, 14u);

    CHECK("x86 totalizes an overlong instruction",
          pl_x86_decode(&image, 0x700000u, &instruction), 0);
    CHECK("x86 overlong status", instruction.status,
          PL_X86_DECODE_TOO_LONG);
    CHECK("x86 overlong instruction is #GP", instruction.trap_vector, 13u);

    CHECK("x86 totalizes an invalid encoding",
          pl_x86_decode(&image, 0x700010u, &instruction), 0);
    CHECK("x86 invalid status", instruction.status,
          PL_X86_DECODE_INVALID);
    CHECK("x86 invalid encoding is #UD", instruction.trap_vector, 6u);
    CHECK("x86 #UD transfer excludes source proof bytes",
          pl_x86_transfer_equal(&explicit_ud, &instruction), 1);
    CHECK("x86 equal #UD transfer hashes agree",
          pl_x86_transfer_hash(&explicit_ud),
          pl_x86_transfer_hash(&instruction));

    pl_x86_catalog catalog;
    CHECK("x86 catalogs every executable byte coordinate",
          pl_x86_catalog_image(&image, NULL, NULL, &catalog), 0);
    CHECK("x86 catalog has no absent coordinate", catalog.coordinates,
          sizeof code + sizeof truncated + 3u + sizeof overlong);
    CHECK("x86 catalog sees decoded coordinates", catalog.decoded != 0u, 1);
    CHECK("x86 catalog sees precise cuts", catalog.precise_cuts != 0u, 1);
    CHECK("x86 catalog sees direct edges", catalog.direct_edges != 0u, 1);
    CHECK("x86 catalog sees indirect edges", catalog.indirect_edges != 0u, 1);
    CHECK("x86 catalog partitions every coordinate",
          catalog.decoded + catalog.invalid + catalog.overlong
              + catalog.fetch_faults,
          catalog.coordinates);

    pl_u32 page_count = 0u;
    CHECK("x86 closure counts executable pages",
          pl_closure_page_count(&image, &page_count), 0);
    CHECK("x86 closure page count", page_count, 4u);
    static pl_u32 page_rows[4u * PL_ENTRY_PAGE_ROWS];
    static pl_u32 tail_rows[64u * PL_ENTRY_TAIL_VALUES];
    static pl_u32 hash_slots[128u];
    pl_entry_map_builder builder;
    CHECK("x86 closure opens physical entry map",
          pl_entry_map_builder_open(
              &builder, page_rows, 4u, tail_rows, 64u,
              hash_slots, 128u, 16u), 0);
    pl_closure_page pages[4];
    pl_closure_report closure;
    CHECK("x86 closure builds total page projection",
          pl_closure_build(
              &image, rank_x86_instruction, NULL, &builder,
              pages, 4u, &closure), 0);
    CHECK("x86 closure publishes every page", closure.pages, 4u);
    CHECK("x86 closure covers every page coordinate",
          closure.coordinates, 4u * PL_ENTRY_PAGE_VALUES);
    CHECK("x86 closure separates mapped coordinates",
          closure.mapped_coordinates,
          sizeof code + sizeof truncated + 3u + sizeof overlong);
    CHECK("x86 closure leaves no absent coordinate",
          closure.mapped_coordinates
              + (closure.coordinates - closure.mapped_coordinates),
          closure.coordinates);
    CHECK("x86 closure records in-image direct edges",
          closure.direct_edges_in_image != 0u, 1);
    CHECK("x86 closure records fault functions",
          closure.fault_coordinates != 0u, 1);
    CHECK("x86 closure page keeps generation", pages[0].generation, 3u);
    CHECK("x86 closure page keeps coordinate",
          pages[3].virtual_page, 0x700000u);
    pl_entry_map entry_map;
    pl_entry_map_finish(&builder, &entry_map);
    pl_u32 function_rank = 0u;
    CHECK("x86 closure maps direct load function",
          pl_entry_map_lookup(
              &entry_map, pages[0].entry_page_rank, 0u, &function_rank), 0);
    CHECK("x86 closure load rank", function_rank, 2u);
    CHECK("x86 closure maps divide function",
          pl_entry_map_lookup(
              &entry_map, pages[0].entry_page_rank, 5u, &function_rank), 0);
    CHECK("x86 closure divide rank", function_rank, 1u);
    CHECK("x86 closure maps truncated fetch fault",
          pl_entry_map_lookup(
              &entry_map, pages[1].entry_page_rank, 0u, &function_rank), 0);
    CHECK("x86 closure fetch-fault rank", function_rank, 0u);
    CHECK("x86 closure shares physical tail rows",
          entry_map.tail_row_count < 4u * PL_ENTRY_PAGE_ROWS, 1);

    /* The same conservative interner is the closure rank callback.  It maps
     * both aliases and all page-padding faults without retaining one decoded
     * instruction object per coordinate. */
    pl_transfer_identity closure_identities[32];
    pl_u32 closure_transfer_slots[64];
    pl_transfer_builder closure_transfers;
    CHECK("x86 alias closure opens transfer classes",
          pl_transfer_builder_open(
              &closure_transfers, &transfer_image,
              closure_identities, 32u, closure_transfer_slots, 64u), 0);
    pl_u32 alias_page_rows[2u * PL_ENTRY_PAGE_ROWS];
    pl_u32 alias_tail_rows[8u * PL_ENTRY_TAIL_VALUES];
    pl_u32 alias_row_slots[16];
    pl_entry_map_builder alias_builder;
    CHECK("x86 alias closure opens entry map",
          pl_entry_map_builder_open(
              &alias_builder, alias_page_rows, 2u, alias_tail_rows, 8u,
              alias_row_slots, 16u, 32u), 0);
    pl_closure_page alias_pages[2];
    pl_closure_report alias_closure;
    CHECK("x86 alias closure assigns conservative transfer ranks",
          pl_closure_build(
              &transfer_image, pl_transfer_rank_instruction,
              &closure_transfers, &alias_builder,
              alias_pages, 2u, &alias_closure), 0);
    CHECK("x86 alias closure covers two total pages",
          alias_closure.coordinates, 2u * PL_ENTRY_PAGE_VALUES);
    CHECK("x86 alias closure admissions match total coordinates",
          closure_transfers.admissions, alias_closure.coordinates);
    CHECK("x86 alias closure shares most coordinates",
          closure_transfers.shared
              > alias_closure.coordinates - PL_ENTRY_PAGE_VALUES, 1);
    CHECK("x86 alias closure retains bounded transfer identities",
          closure_transfers.identity_count <= sizeof code + 1u, 1);
    pl_entry_map alias_entry_map;
    alias_builder.function_count = closure_transfers.identity_count;
    pl_entry_map_finish(&alias_builder, &alias_entry_map);
    pl_u32 physical_function = 0u;
    pl_u32 virtual_function = 0u;
    CHECK("x86 alias closure reads physical function rank",
          pl_entry_map_lookup(
              &alias_entry_map, alias_pages[0].entry_page_rank, 8u,
              &physical_function), 0);
    CHECK("x86 alias closure reads virtual function rank",
          pl_entry_map_lookup(
              &alias_entry_map, alias_pages[1].entry_page_rank, 8u,
              &virtual_function), 0);
    CHECK("x86 alias pages select one function",
          physical_function, virtual_function);
    CHECK("x86 alias pages share quotient tail rows",
          alias_entry_map.tail_row_count, 2u);

    maps[1].address = 0x400001u;
    CHECK("x86 rejects overlapping source maps",
          pl_x86_image_validate(&image), PL_ERROR_X86_MAP);
}

static int lower_at(const pl_x86_image *image, pl_u64 rip,
                    pl_u8 *storage, pl_u32 storage_bytes,
                    pl_x86_instruction *instruction,
                    pl_x86_semantic *semantic)
{
    int status = pl_x86_decode(image, rip, instruction);
    if (status) return status;
    pl_arena arena = { storage, storage_bytes, 0u };
    return pl_x86_lower(instruction, &arena, semantic);
}

static void check_x86_semantics(void)
{
    static const pl_u8 code[] = {
        0x48u, 0x89u, 0xd8u,                         /* mov rax, rbx */
        0xb8u, 0x78u, 0x56u, 0x34u, 0x12u,         /* mov eax, imm32 */
        0x48u, 0x01u, 0xd8u,                         /* add rax, rbx */
        0x48u, 0x39u, 0xd8u,                         /* cmp rax, rbx */
        0x48u, 0x85u, 0xc0u,                         /* test rax, rax */
        0x66u, 0x89u, 0xd8u,                         /* mov ax, bx */
        0x48u, 0x87u, 0xd8u,                         /* xchg rax, rbx */
        0x48u, 0xffu, 0xc0u,                         /* inc rax */
        0x48u, 0xf7u, 0xd0u,                         /* not rax */
        0x48u, 0xf7u, 0xd8u,                         /* neg rax */
        0x90u,                                       /* nop */
        0x48u, 0x8bu, 0x07u,                         /* mov rax, [rdi] */
        0x75u, 0x02u,                                 /* jnz +2 */
        0xffu, 0xe0u,                                 /* jmp rax */
        0xebu, 0xfau,                                 /* jmp -6 */
        0x50u,                                        /* push rax */
        0x5bu,                                        /* pop rbx */
        0xe8u, 0x00u, 0x00u, 0x00u, 0x00u,           /* call next */
        0xffu, 0xd0u,                                 /* call rax */
        0xc3u,                                        /* ret */
        0xc2u, 0x10u, 0x00u,                         /* ret 16 */
        0x48u, 0x0fu, 0xafu, 0xc3u,                  /* imul rax, rbx */
        0x48u, 0x6bu, 0xc3u, 0x05u,                  /* imul rax, rbx, 5 */
        0x48u, 0xf7u, 0xebu,                         /* imul rbx */
        0x48u, 0xf7u, 0xe3u,                         /* mul rbx */
        0x63u, 0xc3u,                                /* movsxd eax, ebx */
        0xd2u, 0xe0u,                                /* shl al, cl */
        0x66u, 0xd3u, 0xe8u,                         /* shr ax, cl */
        0xd0u, 0xc0u,                                /* rol al, 1 */
        0xe2u, 0xfeu,                                /* loop self */
        0xe1u, 0xfeu,                                /* loope self */
        0xe0u, 0xfeu,                                /* loopne self */
        0xe3u, 0xfeu,                                /* jrcxz self */
        0xfau,                                       /* cli */
        0xfbu,                                       /* sti */
        0x48u, 0xf7u, 0xf1u,                         /* div rcx */
        0x48u, 0xf7u, 0xf9u,                         /* idiv rcx */
        0xf6u, 0xf1u,                                /* div cl */
        0xf4u,                                       /* hlt */
    };
    pl_x86_map map = { code, 0x1000u, sizeof code, sizeof code, 5u, 0u };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_u8 storage[4096];
    pl_x86_instruction instruction;
    pl_x86_semantic semantic;

    CHECK("semantic mov64 lowers",
          lower_at(&image, 0x1000u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic mov64 classification", instruction.operation,
          PL_X86_OPERATION_MOVE);
    CHECK("semantic mov64 has zero work", semantic.plan.node_count, 0u);
    CHECK("semantic mov64 aliases rbx", semantic.plan.locals[0].kind,
          PL_OPERAND_LOCAL);
    CHECK("semantic mov64 aliases rbx coordinate",
          semantic.plan.locals[0].value, 3u);
    CHECK("semantic mov64 advances once", semantic.successor_count, 1u);
    CHECK("semantic mov64 successor", semantic.successor[0], 0x1003u);

    CHECK("semantic mov32 immediate lowers",
          lower_at(&image, 0x1003u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic mov32 immediate has zero work",
          semantic.plan.node_count, 0u);
    CHECK("semantic mov32 immediate is a constant",
          semantic.plan.locals[0].kind, PL_OPERAND_CONST);
    CHECK("semantic mov32 immediate zero extends",
          semantic.plan.locals[0].value, 0x12345678u);

    CHECK("semantic add lowers",
          lower_at(&image, 0x1008u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic add is one physical lane", semantic.plan.node_count, 1u);
    CHECK("semantic add uses the fused ALU",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_ALU);
    CHECK("semantic add publishes the result projection",
          semantic.plan.locals[0].kind, PL_OPERAND_PROJECTION);
    CHECK("semantic add result is selector 16",
          semantic.plan.locals[0].value, (1u << 8u) | 16u);
    CHECK("semantic add publishes flags from the same lane",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 1u);
    CHECK("semantic add descriptor",
          semantic.plan.arguments[3].value, 64u | (1u << 8u));

    CHECK("semantic compare lowers",
          lower_at(&image, 0x100bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic compare is one physical lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic compare uses compare flags",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_COMPARE);
    CHECK("semantic compare leaves rax unchanged",
          semantic.plan.locals[0].value, 0u);
    CHECK("semantic compare descriptor",
          semantic.plan.arguments[3].value, 64u | (3u << 8u));

    CHECK("semantic test lowers",
          lower_at(&image, 0x100eu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic test uses one test lane",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_TEST);
    CHECK("semantic test descriptor", semantic.plan.arguments[3].value, 64u);

    CHECK("semantic partial move lowers",
          lower_at(&image, 0x1011u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic partial move is one insert",
          semantic.plan.node_count, 1u);
    CHECK("semantic partial move uses insert",
          semantic.plan.nodes[0].opcode, PL_OPCODE_LANE64_INSERT);
    CHECK("semantic partial move keeps destination base",
          semantic.plan.arguments[0].value, 0u);
    CHECK("semantic partial move reads rbx",
          semantic.plan.arguments[1].value, 3u);
    CHECK("semantic partial move width", semantic.plan.arguments[2].value, 16u);

    CHECK("semantic exchange lowers",
          lower_at(&image, 0x1014u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic exchange64 has zero work", semantic.plan.node_count, 0u);
    CHECK("semantic exchange writes rbx into rax",
          semantic.plan.locals[0].value, 3u);
    CHECK("semantic exchange writes rax into rbx",
          semantic.plan.locals[3].value, 0u);

    CHECK("semantic increment lowers",
          lower_at(&image, 0x1017u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic increment is one physical lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic increment preserves carry",
          semantic.plan.arguments[3].value,
          64u | (1u << 8u) | (1u << 11u));

    CHECK("semantic complement lowers",
          lower_at(&image, 0x101au, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic complement is one physical lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic complement leaves flags unchanged",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].kind, PL_OPERAND_LOCAL);

    CHECK("semantic negate lowers",
          lower_at(&image, 0x101du, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic negate is one fused ALU", semantic.plan.node_count, 1u);
    CHECK("semantic negate uses subtraction",
          semantic.plan.arguments[3].value, 64u | (3u << 8u));
    CHECK("semantic negate starts at zero",
          semantic.plan.arguments[1].value, 0u);

    CHECK("semantic nop lowers",
          lower_at(&image, 0x1020u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic nop has zero work", semantic.plan.node_count, 0u);

    CHECK("semantic memory move lowers",
          lower_at(&image, 0x1021u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory move is one physical load",
          semantic.plan.node_count, 1u);
    CHECK("semantic memory move uses the shared load vocabulary",
          semantic.plan.nodes[0].opcode, PL_OPCODE_REGION_LOAD[1][8][0]);
    CHECK("semantic memory move reads rdi directly",
          semantic.plan.arguments[0].kind, PL_OPERAND_LOCAL);
    CHECK("semantic memory move rdi coordinate",
          semantic.plan.arguments[0].value, 7u);
    CHECK("semantic memory move publishes the load",
          semantic.plan.locals[0].value, 1u);

    CHECK("semantic conditional branch lowers",
          lower_at(&image, 0x1024u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic conditional branch classification",
          instruction.operation, PL_X86_OPERATION_BRANCH);
    CHECK("semantic conditional branch condition", instruction.condition, 5u);
    CHECK("semantic conditional branch is one predicate lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic conditional branch uses flags predicate",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_CONDITION);
    CHECK("semantic conditional branch has two successors",
          semantic.successor_count, 2u);
    CHECK("semantic conditional branch taken successor",
          semantic.successor[0], 0x1028u);
    CHECK("semantic conditional branch fallthrough",
          semantic.successor[1], 0x1026u);

    CHECK("semantic indirect jump lowers",
          lower_at(&image, 0x1026u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic indirect jump has no SSA work",
          semantic.plan.node_count, 0u);
    CHECK("semantic indirect jump marks its target dynamic",
          semantic.dynamic_target, 1u);
    CHECK("semantic indirect jump target is rax",
          semantic.target.kind, PL_OPERAND_LOCAL);
    CHECK("semantic indirect jump target coordinate",
          semantic.target.value, 0u);

    CHECK("semantic direct jump lowers",
          lower_at(&image, 0x1028u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic direct jump has zero work",
          semantic.plan.node_count, 0u);
    CHECK("semantic direct jump successor", semantic.successor[0], 0x1024u);

    CHECK("semantic push lowers",
          lower_at(&image, 0x102au, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic push classification", instruction.operation,
          PL_X86_OPERATION_PUSH);
    CHECK("semantic push has address and store work",
          semantic.plan.node_count, 2u);
    CHECK("semantic push publishes decremented rsp",
          semantic.plan.locals[4].value, 1u);
    CHECK("semantic push stores through shared memory lane",
          semantic.plan.nodes[1].opcode, PL_OPCODE_MEMORY_STORE);

    CHECK("semantic pop lowers",
          lower_at(&image, 0x102bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic pop classification", instruction.operation,
          PL_X86_OPERATION_POP);
    CHECK("semantic pop load and rsp update are one wave",
          semantic.plan.span, 1u);
    CHECK("semantic pop publishes loaded rbx",
          semantic.plan.locals[3].value, 1u);
    CHECK("semantic pop publishes incremented rsp",
          semantic.plan.locals[4].value, 2u);

    static const pl_u8 pop_memory_code[] = {
        0x8fu, 0x04u, 0x24u,            /* pop qword [rsp] */
    };
    pl_x86_map pop_memory_map = {
        pop_memory_code, 0x10f0u, sizeof pop_memory_code,
        sizeof pop_memory_code, 5u, 0u,
    };
    pl_x86_image pop_memory_image = {
        &pop_memory_map, 1u, 0u, 0x10f0u,
    };
    CHECK("semantic memory pop lowers without a machine escape",
          lower_at(&pop_memory_image, 0x10f0u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory pop substitutes post-increment rsp",
          semantic.plan.node_count, 3u);
    CHECK("semantic memory pop ends in the shared store lane",
          semantic.plan.nodes[2].opcode, PL_OPCODE_MEMORY_STORE);
    CHECK("semantic memory pop has no anonymous barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 0u);

    CHECK("semantic direct call lowers",
          lower_at(&image, 0x102cu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic direct call classification", instruction.operation,
          PL_X86_OPERATION_CALL);
    CHECK("semantic direct call target", semantic.target.value, 0x1031u);
    CHECK("semantic direct call pushes return address",
          semantic.plan.nodes[1].opcode, PL_OPCODE_MEMORY_STORE);

    CHECK("semantic indirect call lowers",
          lower_at(&image, 0x1031u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic indirect call marks its target dynamic",
          semantic.dynamic_target, 1u);
    CHECK("semantic indirect call target is rax",
          semantic.target.value, 0u);

    CHECK("semantic return lowers",
          lower_at(&image, 0x1033u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic return classification", instruction.operation,
          PL_X86_OPERATION_RETURN);
    CHECK("semantic return target is the stack load",
          semantic.target.kind, PL_OPERAND_NODE);
    CHECK("semantic return target load coordinate", semantic.target.value, 1u);
    CHECK("semantic return increments rsp by eight",
          semantic.plan.arguments[4].value, 8u);

    CHECK("semantic return immediate lowers",
          lower_at(&image, 0x1034u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic return immediate adds cleanup to rsp",
          semantic.plan.arguments[4].value, 24u);

    CHECK("semantic two-operand imul lowers",
          lower_at(&image, 0x1037u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic imul classification", instruction.operation,
          PL_X86_OPERATION_MULTIPLY_SIGNED);
    CHECK("semantic imul is low, high and one flag lane",
          semantic.plan.node_count, 3u);
    CHECK("semantic imul uses the physical multiply",
          semantic.plan.nodes[0].opcode, PL_OPCODE_MULR);
    CHECK("semantic imul uses signed multiply-high",
          semantic.plan.nodes[1].opcode, PL_OPCODE_MUL_HIGH);
    CHECK("semantic imul signed descriptor",
          semantic.plan.arguments[4].value, 64u | (1u << 8u));
    CHECK("semantic imul publishes the low product",
          semantic.plan.locals[0].value, 1u);
    CHECK("semantic imul publishes flags after both halves",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 3u);

    CHECK("semantic immediate imul lowers",
          lower_at(&image, 0x103bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic immediate imul remains three physical lanes",
          semantic.plan.node_count, 3u);
    CHECK("semantic immediate imul retains the multiplier",
          semantic.plan.arguments[1].value, 5u);

    CHECK("semantic implicit imul lowers",
          lower_at(&image, 0x103fu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic implicit imul publishes low rax",
          semantic.plan.locals[0].value, 1u);
    CHECK("semantic implicit imul publishes high rdx",
          semantic.plan.locals[2].value, 2u);

    CHECK("semantic implicit mul lowers",
          lower_at(&image, 0x1042u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic mul classification", instruction.operation,
          PL_X86_OPERATION_MULTIPLY_UNSIGNED);
    CHECK("semantic mul unsigned descriptor",
          semantic.plan.arguments[4].value, 64u);

    CHECK("semantic same-width movsxd lowers",
          lower_at(&image, 0x1045u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic same-width movsxd remains sign-move family",
          instruction.operation, PL_X86_OPERATION_MOVE_SIGN_EXTEND);
    CHECK("semantic same-width movsxd is a single zeroing insert",
          semantic.plan.node_count, 1u);
    CHECK("semantic same-width movsxd writes the low 32 bits",
          semantic.plan.arguments[2].value, 32u);

    CHECK("semantic dynamic byte shift lowers",
          lower_at(&image, 0x1047u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic byte shift keeps the five-bit x86 count mask",
          semantic.plan.arguments[1].value, 31u);
    CHECK("semantic byte shift uses a 64-bit physical shift",
          semantic.plan.nodes[2].opcode, PL_OPCODE_LANE64_SHLR);
    CHECK("semantic byte shift publishes exact flags",
          semantic.plan.nodes[3].opcode, PL_OPCODE_X86_SHIFT_FLAGS);

    CHECK("semantic dynamic word shift lowers",
          lower_at(&image, 0x1049u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic word shift keeps the five-bit x86 count mask",
          semantic.plan.arguments[1].value, 31u);
    CHECK("semantic word shift uses logical right",
          semantic.plan.nodes[2].opcode, PL_OPCODE_LANE64_SHRR);

    CHECK("semantic byte rotate lowers",
          lower_at(&image, 0x104cu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic byte rotate is a closed six-work physical spelling",
          semantic.plan.node_count, 6u);
    CHECK("semantic byte rotate keeps modulo-eight amount",
          semantic.plan.arguments[4].value, 1u);

    CHECK("semantic loop lowers",
          lower_at(&image, 0x104eu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic loop classification", instruction.operation,
          PL_X86_OPERATION_LOOP);
    CHECK("semantic loop is decrement plus test",
          semantic.plan.node_count, 2u);
    CHECK("semantic loop updates rcx without flags",
          semantic.plan.locals[1].value, 1u);
    CHECK("semantic loop leaves rflags unchanged",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].kind, PL_OPERAND_LOCAL);
    CHECK("semantic loop uses the decremented count predicate",
          semantic.predicate.value, 2u);
    CHECK("semantic loop target", semantic.successor[0], 0x104eu);

    CHECK("semantic loope lowers",
          lower_at(&image, 0x1050u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic loope is count, flags and conjunction",
          semantic.plan.node_count, 4u);
    CHECK("semantic loope terminal predicate", semantic.predicate.value, 4u);

    CHECK("semantic loopne lowers",
          lower_at(&image, 0x1052u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic loopne is count, flags and conjunction",
          semantic.plan.node_count, 4u);

    CHECK("semantic jrcxz lowers",
          lower_at(&image, 0x1054u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic jrcxz classification", instruction.operation,
          PL_X86_OPERATION_COUNT_ZERO_BRANCH);
    CHECK("semantic jrcxz is one physical predicate",
          semantic.plan.node_count, 1u);
    CHECK("semantic jrcxz leaves rcx unchanged",
          semantic.plan.locals[1].kind, PL_OPERAND_LOCAL);

    CHECK("semantic cli lowers to the privilege-aware VM cut",
          lower_at(&image, 0x1056u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic cli names the interrupt flag machine operation",
          semantic.machine_operation, PL_X86_MACHINE_INTERRUPT_FLAG);

    CHECK("semantic sti lowers to the interrupt-shadow machine cut",
          lower_at(&image, 0x1057u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic sti names the interrupt flag machine operation",
          semantic.machine_operation, PL_X86_MACHINE_INTERRUPT_FLAG);
    CHECK("semantic sti requests the enabled shadow state",
          semantic.machine_argument, 1u);

    CHECK("semantic unsigned divide lowers",
          lower_at(&image, 0x1058u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic unsigned divide classification", instruction.operation,
          PL_X86_OPERATION_DIVIDE_UNSIGNED);
    CHECK("semantic divide is one physical result", semantic.plan.node_count,
          1u);
    CHECK("semantic divide uses the exact double-width primitive",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_DIVIDE);
    CHECK("semantic divide descriptor", semantic.plan.arguments[3].value,
          64u);
    CHECK("semantic divide publishes quotient projection",
          semantic.plan.locals[0].value, (1u << 8u));
    CHECK("semantic divide publishes remainder projection",
          semantic.plan.locals[2].value, (1u << 8u) | 1u);
    CHECK("semantic divide exposes an atomic #DE predicate",
          semantic.has_fault_predicate, 1u);
    CHECK("semantic divide fault predicate is its physical result",
          semantic.fault_predicate.value, 1u);

    CHECK("semantic signed divide lowers",
          lower_at(&image, 0x105bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic signed divide classification", instruction.operation,
          PL_X86_OPERATION_DIVIDE_SIGNED);
    CHECK("semantic signed divide descriptor", semantic.plan.arguments[3].value,
          64u | (1u << 8u));

    CHECK("semantic byte divide lowers",
          lower_at(&image, 0x105eu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic byte divide retains the double-width AX source",
          semantic.plan.nodes[1].opcode, PL_OPCODE_X86_DIVIDE);
    CHECK("semantic byte divide descriptor", semantic.plan.arguments[5].value,
          8u);
    CHECK("semantic byte divide publishes AL:AH atomically",
          semantic.plan.locals[0].kind, PL_OPERAND_NODE);

    CHECK("semantic hlt lowers to a dormant machine cut",
          lower_at(&image, 0x1060u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic hlt names the typed halt operation",
          semantic.machine_operation, PL_X86_MACHINE_HALT);

    static const pl_u8 rotate_code[] = {
        0xd1u, 0xd8u,                   /* rcr eax, 1 */
        0x48u, 0xd3u, 0xd0u,            /* rcl rax, cl */
        0xc1u, 0x10u, 0x08u,            /* rcl dword [rax], 8 */
        0xc1u, 0x10u, 0x00u,            /* rcl dword [rax], 0 */
        0x48u, 0xd3u, 0x10u,            /* rcl qword [rax], cl */
    };
    pl_x86_map rotate_map = {
        rotate_code, 0x2000u, sizeof rotate_code, sizeof rotate_code, 5u, 0u,
    };
    pl_x86_image rotate_image = { &rotate_map, 1u, 0u, 0x2000u };
    CHECK("semantic RCR lowers to one physical lane",
          lower_at(&rotate_image, 0x2000u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic RCR physical work", semantic.plan.node_count, 1u);
    CHECK("semantic RCR uses the fused carry ring",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_ROTATE_CARRY);
    CHECK("semantic RCR direction descriptor",
          semantic.plan.arguments[3].value, 32u | (1u << 8u));
    CHECK("semantic RCR publishes its value projection",
          semantic.plan.locals[0].value, (1u << 8u) | 16u);

    CHECK("semantic dynamic RCL lowers to one physical lane",
          lower_at(&rotate_image, 0x2002u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic dynamic RCL physical work",
          semantic.plan.node_count, 1u);
    CHECK("semantic RCL direction descriptor",
          semantic.plan.arguments[3].value, 64u);

    CHECK("semantic memory RCL remains one RMW transaction",
          lower_at(&rotate_image, 0x2005u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory RCL is load, ring and store",
          semantic.plan.node_count, 3u);
    CHECK("semantic memory RCL keeps one fused arithmetic lane",
          semantic.plan.nodes[1].opcode, PL_OPCODE_X86_ROTATE_CARRY);
    CHECK("semantic memory RCL stores the value projection",
          semantic.plan.arguments[8].kind, PL_OPERAND_PROJECTION);

    CHECK("semantic zero-count memory RCL lowers",
          lower_at(&rotate_image, 0x2008u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic zero-count RCL performs only its faulting read",
          semantic.plan.node_count, 1u);
    CHECK("semantic zero-count RCL does not publish flags",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].kind, PL_OPERAND_LOCAL);

    CHECK("semantic dynamic memory RCL lowers",
          lower_at(&rotate_image, 0x200bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic dynamic memory RCL is load, ring and conditional store",
          semantic.plan.node_count, 3u);
    CHECK("semantic dynamic memory RCL suppresses its zero-count write",
          semantic.plan.nodes[2].opcode, PL_OPCODE_MEMORY_STORE_IF);
    CHECK("semantic dynamic memory RCL uses the normalized active projection",
          semantic.plan.arguments[9].value, (2u << 8u) | 17u);

    static const pl_u8 exchange_code[] = {
        0x86u, 0xd8u,                   /* xchg al, bl */
        0x86u, 0xdcu,                   /* xchg ah, bl */
        0x86u, 0xe0u,                   /* xchg al, ah */
        0x87u, 0xc0u,                   /* xchg eax, eax */
        0x48u, 0x87u, 0xc0u,            /* xchg rax, rax */
    };
    pl_x86_map exchange_map = {
        exchange_code, 0x3000u, sizeof exchange_code,
        sizeof exchange_code, 5u, 0u,
    };
    pl_x86_image exchange_image = { &exchange_map, 1u, 0u, 0x3000u };
    CHECK("semantic low-byte exchange lowers",
          lower_at(&exchange_image, 0x3000u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic low-byte exchange is two parallel inserts",
          semantic.plan.node_count, 2u);
    CHECK("semantic low-byte exchange span", semantic.plan.span, 1u);
    CHECK("semantic high-byte exchange lowers",
          lower_at(&exchange_image, 0x3002u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic high-byte exchange reads once and publishes twice",
          semantic.plan.node_count, 3u);
    CHECK("semantic high-byte exchange span", semantic.plan.span, 2u);
    CHECK("semantic overlapping-byte exchange lowers",
          lower_at(&exchange_image, 0x3004u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic overlapping-byte exchange composes one final word",
          semantic.plan.node_count, 3u);
    CHECK("semantic overlapping-byte exchange publishes final insert",
          semantic.plan.locals[0].value, 3u);
    CHECK("semantic same eax exchange lowers",
          lower_at(&exchange_image, 0x3006u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic same eax exchange retains zero-extension",
          semantic.plan.node_count, 1u);
    CHECK("semantic same rax exchange is identity",
          lower_at(&exchange_image, 0x3008u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic same rax exchange has zero work",
          semantic.plan.node_count, 0u);

    static const pl_u8 machine_code[] = {
        0xf0u, 0x48u, 0x01u, 0x18u,    /* lock add [rax], rbx */
        0x0fu, 0x20u, 0xc0u,           /* mov rax, cr0 */
        0xc7u, 0xf8u, 0x00u, 0x00u, 0x00u, 0x00u, /* xbegin next */
        0x0fu, 0xa0u,                   /* push fs */
        0xd8u, 0xc1u,                   /* fadd st(0), st(1) */
        0xf0u, 0x80u, 0x00u, 0x0fu,    /* lock add byte [rax], 15 */
        0xf0u, 0x81u, 0x20u, 0x78u, 0x56u, 0x34u, 0x12u,
                                           /* lock and dword [rax], 12345678h */
        0xf0u, 0x48u, 0x83u, 0x28u, 0xffu,
                                           /* lock sub qword [rax], -1 */
    };
    pl_x86_map machine_map = {
        machine_code, 0x3100u, sizeof machine_code,
        sizeof machine_code, 5u, 0u,
    };
    pl_x86_image machine_image = { &machine_map, 1u, 0u, 0x3100u };
    CHECK("semantic locked memory add lowers to the atomic transaction",
          lower_at(&machine_image, 0x3100u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic lock names the atomic machine cut",
          semantic.machine_operation, PL_X86_MACHINE_ATOMIC);
    CHECK("semantic control-register read owns a typed machine transfer",
          lower_at(&machine_image, 0x3104u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic control-register read operation",
          instruction.machine_operation, PL_X86_MACHINE_READ_CONTROL);
    CHECK("semantic control-register move owns a machine barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);
    CHECK("semantic transaction begin is withheld from RFLAGS SSA",
          lower_at(&machine_image, 0x3107u, storage, sizeof storage,
                   &instruction, &semantic), PL_ERROR_X86_SEMANTIC);
    CHECK("semantic transaction begin owns a machine barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);
    CHECK("semantic segment push lowers to its restartable machine cut",
          lower_at(&machine_image, 0x310du, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic segment push names the FS stack transfer",
          semantic.machine_operation, PL_X86_MACHINE_SEGMENT_STACK);
    CHECK("semantic segment push owns a machine barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);
    CHECK("semantic implicit x87 state lowers to the typed x87 cut",
          lower_at(&machine_image, 0x310fu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic implicit x87 state names the x87 operation",
          semantic.machine_operation, PL_X86_MACHINE_X87);
    CHECK("semantic implicit x87 state owns a machine barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);
    CHECK("semantic locked byte immediate add lowers",
          lower_at(&machine_image, 0x3111u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic locked byte immediate descriptor",
          semantic.machine_argument,
          4ull | (1ull << 8u) | (1ull << 25u) | (0x0full << 32u));
    CHECK("semantic locked dword immediate and lowers",
          lower_at(&machine_image, 0x3115u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic locked dword immediate descriptor",
          semantic.machine_argument,
          8ull | (4ull << 8u) | (1ull << 25u)
               | (0x12345678ull << 32u));
    CHECK("semantic locked qword sign-extended immediate sub lowers",
          lower_at(&machine_image, 0x311cu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic locked qword immediate descriptor",
          semantic.machine_argument,
          9ull | (8ull << 8u) | (1ull << 25u)
               | (0xffffffffull << 32u));

    static const pl_u8 extend_code[] = {
        0x66u, 0x63u, 0x00u,           /* movsxd ax, dword [rax] */
        0x66u, 0x0fu, 0xb7u, 0x03u,    /* movzx ax, word [rbx] */
        0x66u, 0x0fu, 0xbfu, 0xf6u,    /* movsx si, si */
    };
    pl_x86_map extend_map = {
        extend_code, 0x3200u, sizeof extend_code,
        sizeof extend_code, 5u, 0u,
    };
    pl_x86_image extend_image = { &extend_map, 1u, 0u, 0x3200u };
    CHECK("semantic narrow-destination movsxd lowers",
          lower_at(&extend_image, 0x3200u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic movsxd retains its four-byte faulting read",
          semantic.plan.arguments[2].value & 0xffu, 4u);
    CHECK("semantic same-width movzx lowers",
          lower_at(&extend_image, 0x3203u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic same-width movzx retains its two-byte read",
          semantic.plan.arguments[2].value & 0xffu, 2u);
    CHECK("semantic identical same-width movsx lowers",
          lower_at(&extend_image, 0x3207u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic identical same-width movsx is identity",
          semantic.plan.node_count, 0u);

    static const pl_u8 flags_code[] = {
        0x9fu,                         /* lahf */
        0x9eu,                         /* sahf */
        0x9cu,                         /* pushfq */
        0x66u, 0x9cu,                  /* pushfw */
        0x9du,                         /* popfq */
    };
    pl_x86_map flags_map = {
        flags_code, 0x3300u, sizeof flags_code,
        sizeof flags_code, 5u, 0u,
    };
    pl_x86_image flags_image = { &flags_map, 1u, 0u, 0x3300u };
    CHECK("semantic lahf lowers",
          lower_at(&flags_image, 0x3300u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic lahf is mask, fixed bit and high-byte publication",
          semantic.plan.node_count, 3u);
    CHECK("semantic lahf publishes ah", semantic.plan.locals[0].value, 3u);
    CHECK("semantic sahf lowers",
          lower_at(&flags_image, 0x3301u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic sahf retains one packed flags publication",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 4u);
    CHECK("semantic sahf dependency span", semantic.plan.span, 3u);
    CHECK("semantic pushfq lowers",
          lower_at(&flags_image, 0x3302u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic pushfq clears vm/rf then stores once",
          semantic.plan.node_count, 3u);
    CHECK("semantic pushfq publishes decremented rsp",
          semantic.plan.locals[4].value, 2u);
    CHECK("semantic pushfw lowers",
          lower_at(&flags_image, 0x3303u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic pushfw needs only address and store",
          semantic.plan.node_count, 2u);
    CHECK("semantic popfq lowers to a typed privilege-aware machine cut",
          lower_at(&flags_image, 0x3305u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic popfq names the direct flag-stack transfer",
          semantic.machine_operation, PL_X86_MACHINE_POP_FLAGS);
    CHECK("semantic popfq retains its architectural width",
          semantic.machine_argument, 64u);

    static const pl_u8 bit_code[] = {
        0x48u, 0x0fu, 0xa3u, 0xd8u,    /* bt rax, rbx */
        0x48u, 0x0fu, 0xabu, 0xd8u,    /* bts rax, rbx */
        0x66u, 0x0fu, 0xa3u, 0x18u,    /* bt word [rax], bx */
        0x48u, 0x0fu, 0xbau, 0x30u, 0x05u, /* btr qword [rax], 5 */
        0xf0u, 0x48u, 0x0fu, 0xabu, 0x18u, /* lock bts [rax], rbx */
    };
    pl_x86_map bit_map = {
        bit_code, 0x3400u, sizeof bit_code,
        sizeof bit_code, 5u, 0u,
    };
    pl_x86_image bit_image = { &bit_map, 1u, 0u, 0x3400u };
    CHECK("semantic register bt lowers",
          lower_at(&bit_image, 0x3400u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic register bt is one fused flag lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic register bt publishes only flags",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 1u);
    CHECK("semantic register bts lowers",
          lower_at(&bit_image, 0x3404u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic register bts uses one bounded bit path",
          semantic.plan.node_count, 4u);
    CHECK("semantic register bts publishes changed rax",
          semantic.plan.locals[0].value, 4u);
    CHECK("semantic memory bt with 16-bit index lowers",
          lower_at(&bit_image, 0x3408u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory bt uses one quotient address lane",
          semantic.plan.nodes[0].opcode, PL_OPCODE_BIT_ADDRESS);
    CHECK("semantic memory bt retains signed 16-bit index geometry",
          semantic.plan.arguments[2].value, 16u | (16u << 8u));
    CHECK("semantic immediate memory btr lowers",
          lower_at(&bit_image, 0x340cu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic immediate memory btr is load, flags, clear and store",
          semantic.plan.node_count, 4u);
    CHECK("semantic locked memory bts lowers to atomic machine state",
          lower_at(&bit_image, 0x3411u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic locked memory bts names the bit-string transaction",
          semantic.machine_operation, PL_X86_MACHINE_ATOMIC);
    CHECK("semantic locked memory bts retains width and index register",
          semantic.machine_argument,
          14ull | (8ull << 8u) | (3ull << 16u));
    CHECK("semantic locked memory bts owns a barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);

    static const pl_u8 misc_code[] = {
        0xd7u,                         /* xlat */
        0x67u, 0xd7u,                  /* xlat with 32-bit address */
        0x48u, 0x0fu, 0xc8u,           /* bswap rax */
        0x0fu, 0xc8u,                  /* bswap eax */
        0xf3u, 0x90u,                  /* pause */
        0x9bu,                         /* fwait */
        0x0fu, 0xa2u,                  /* cpuid */
        0x0fu, 0xaeu, 0xe8u,           /* lfence */
        0x0fu, 0x01u, 0xcau,           /* clac */
        0x0fu, 0x01u, 0xcbu,           /* stac */
        0xc8u, 0x20u, 0x00u, 0x02u,    /* enter 32, 2 */
        0x66u, 0xc8u, 0x10u, 0x00u, 0x1fu, /* enterw 16, 31 */
        0xa4u,                         /* movsb */
        0xabu,                         /* stosd */
        0x48u, 0xadu,                  /* lodsq */
        0xa7u,                         /* cmpsd */
        0xaeu,                         /* scasb */
        0x67u, 0xa4u,                  /* address32 movsb */
        0x64u, 0xa4u,                  /* fs movsb */
        0xf3u, 0xa4u,                  /* rep movsb */
        0xf2u, 0xaeu,                  /* repne scasb */
        0x0fu, 0xc1u, 0xd8u,           /* xadd eax, ebx */
        0x48u, 0x0fu, 0xc1u, 0x18u,    /* xadd [rax], rbx */
        0x0fu, 0xc0u, 0xe0u,           /* xadd al, ah */
        0xf0u, 0x48u, 0x0fu, 0xc1u, 0x18u, /* lock xadd [rax], rbx */
        0x0fu, 0xb1u, 0xd8u,           /* cmpxchg eax, ebx */
        0x0fu, 0xb0u, 0xdcu,           /* cmpxchg ah, bl */
        0x0fu, 0xb1u, 0x18u,           /* cmpxchg [rax], ebx */
    };
    pl_x86_map misc_map = {
        misc_code, 0x3500u, sizeof misc_code,
        sizeof misc_code, 5u, 0u,
    };
    pl_x86_image misc_image = { &misc_map, 1u, 0u, 0x3500u };
    CHECK("semantic xlat lowers",
          lower_at(&misc_image, 0x3500u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic xlat is mask, address, load and byte publication",
          semantic.plan.node_count, 4u);
    CHECK("semantic xlat publishes al", semantic.plan.locals[0].value, 4u);
    CHECK("semantic address32 xlat lowers",
          lower_at(&misc_image, 0x3501u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic address32 xlat wraps in the i32 lane",
          semantic.plan.nodes[1].opcode, PL_OPCODE_ALU_REGISTER[0][1]);
    CHECK("semantic bswap rax lowers",
          lower_at(&misc_image, 0x3503u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic bswap rax is one physical lane",
          semantic.plan.nodes[0].opcode, PL_OPCODE_LANE64_BSWAP);
    CHECK("semantic bswap eax lowers",
          lower_at(&misc_image, 0x3506u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic bswap eax is one physical lane",
          semantic.plan.nodes[0].opcode, PL_OPCODE_LANE32_BSWAP);
    CHECK("semantic pause is an identity hint",
          lower_at(&misc_image, 0x3508u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic pause has zero work", semantic.plan.node_count, 0u);
    CHECK("semantic cpuid lowers to the shared virtual CPU projection",
          lower_at(&misc_image, 0x350bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic cpuid names a typed machine operation",
          semantic.machine_operation, PL_X86_MACHINE_CPUID);
    CHECK("semantic fwait lowers to persistent x87 state",
          lower_at(&misc_image, 0x350au, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic fwait names the x87 machine cut",
          semantic.machine_operation, PL_X86_MACHINE_X87);
    CHECK("semantic lfence lowers to the typed memory-order cut",
          lower_at(&misc_image, 0x350du, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic lfence names memory ordering",
          semantic.machine_operation, PL_X86_MACHINE_MEMORY_ORDER);
    CHECK("semantic lfence remains a block barrier",
          !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);
    const pl_u64 barrier_coordinates[] = { 0x3510u, 0x3513u };
    for (pl_u32 index = 0u;
            index < sizeof barrier_coordinates
                  / sizeof barrier_coordinates[0]; ++index) {
        CHECK("semantic host/memory-order op is withheld",
              lower_at(&misc_image, barrier_coordinates[index],
                       storage, sizeof storage, &instruction, &semantic),
              PL_ERROR_X86_SEMANTIC);
        CHECK("semantic host/memory-order op owns a barrier",
              !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER), 1);
    }
    CHECK("semantic enter lowers",
          lower_at(&misc_image, 0x3516u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic enter keeps all implicit pushes in one transaction",
          semantic.plan.nodes[1].opcode, PL_OPCODE_MEMORY_FRAME);
    CHECK("semantic enter has bounded physical work",
          semantic.plan.node_count, 3u);
    CHECK("semantic enter publishes the closed rsp expression",
          semantic.plan.locals[4].value, 3u);
    CHECK("semantic enter publishes frame as rbp",
          semantic.plan.locals[5].value, 1u);
    CHECK("semantic enterw lowers",
          lower_at(&misc_image, 0x351au, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic enterw preserves upper rbp in one insert",
          semantic.plan.locals[5].value, 4u);
    CHECK("semantic movsb lowers",
          lower_at(&misc_image, 0x351fu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic movsb is one load/store plus closed index updates",
          semantic.plan.node_count, 6u);
    CHECK("semantic movsb publishes rsi and rdi",
          semantic.plan.locals[6].kind == PL_OPERAND_NODE
          && semantic.plan.locals[7].kind == PL_OPERAND_NODE, 1);
    CHECK("semantic stosd lowers",
          lower_at(&misc_image, 0x3520u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic stosd has one memory effect",
          semantic.plan.nodes[0].opcode, PL_OPCODE_MEMORY_STORE32);
    CHECK("semantic lodsq lowers",
          lower_at(&misc_image, 0x3521u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic lodsq publishes the load directly to rax",
          semantic.plan.locals[0].value, 1u);
    CHECK("semantic cmpsd lowers",
          lower_at(&misc_image, 0x3523u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic cmpsd publishes one compare flags lane",
          semantic.plan.nodes[2].opcode, PL_OPCODE_X86_COMPARE);
    CHECK("semantic scasb lowers",
          lower_at(&misc_image, 0x3524u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic address32 movsb lowers",
          lower_at(&misc_image, 0x3525u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic address32 movsb wraps both indices before access",
          semantic.plan.node_count, 8u);
    CHECK("semantic fs movsb lowers",
          lower_at(&misc_image, 0x3527u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic fs movsb includes the segment base once",
          semantic.plan.node_count, 7u);
    CHECK("semantic rep movsb lowers to residual machine state",
          lower_at(&misc_image, 0x3529u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic rep movsb names one typed state-step",
          semantic.machine_operation, PL_X86_MACHINE_STRING);
    CHECK("semantic rep movsb has no scalar element graph",
          semantic.plan.node_count, 0u);
    CHECK("semantic repeated compare lowers to residual machine state",
          lower_at(&misc_image, 0x352bu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic repeated compare names one typed state-step",
          semantic.machine_operation, PL_X86_MACHINE_STRING);
    CHECK("semantic repeated compare has no scalar element graph",
          semantic.plan.node_count, 0u);
    CHECK("semantic register xadd lowers",
          lower_at(&misc_image, 0x352du, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic register xadd is one add plus parallel publication",
          semantic.plan.node_count, 2u);
    CHECK("semantic register xadd publishes fused flags",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 1u);
    CHECK("semantic memory xadd lowers",
          lower_at(&misc_image, 0x3530u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory xadd is load, fused add and store",
          semantic.plan.node_count, 3u);
    CHECK("semantic overlapping byte xadd lowers",
          lower_at(&misc_image, 0x3534u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic overlapping byte xadd composes one final gpr",
          semantic.plan.locals[0].value, 4u);
    CHECK("semantic locked xadd lowers to an atomic machine operation",
          lower_at(&misc_image, 0x3537u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic locked xadd names the atomic transaction",
          semantic.machine_operation, PL_X86_MACHINE_ATOMIC);
    CHECK("semantic register cmpxchg lowers",
          lower_at(&misc_image, 0x353cu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic same-accumulator cmpxchg has no dead publication",
          semantic.plan.node_count, 2u);
    CHECK("semantic high-byte cmpxchg lowers",
          lower_at(&misc_image, 0x353fu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic high-byte cmpxchg composes ah and al",
          semantic.plan.locals[0].kind, PL_OPERAND_NODE);
    CHECK("semantic memory cmpxchg lowers with its write-access cut",
          lower_at(&misc_image, 0x3542u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory cmpxchg names the atomic transaction",
          semantic.machine_operation, PL_X86_MACHINE_ATOMIC);

    static const pl_u8 string_port_code[] = {
        0xf3u, 0x6cu,             /* rep insb [es:rdi], dx */
        0x67u, 0x6fu,             /* outsd dx, [esi] */
        0x64u, 0xf3u, 0x6eu,      /* rep outsb dx, [fs:rsi] */
    };
    pl_x86_map string_port_map = {
        string_port_code, 0x3580u, sizeof string_port_code,
        sizeof string_port_code, 5u, 0u,
    };
    pl_x86_image string_port_image = {
        &string_port_map, 1u, 0u, 0x3580u,
    };
    CHECK("semantic rep insb lowers to one restartable port transaction",
          lower_at(&string_port_image, 0x3580u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic rep insb names the shared port machine operation",
          semantic.machine_operation, PL_X86_MACHINE_PORT_IO);
    CHECK("semantic rep insb descriptor records string and repetition",
          (semantic.machine_argument >> 10u) & 3u, 3u);
    CHECK("semantic rep insb descriptor records 64-bit ES destination",
          (semantic.machine_argument >> 16u) & 0xffffu, 64u);
    CHECK("semantic address32 outsd lowers to the same port transaction",
          lower_at(&string_port_image, 0x3582u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic address32 outsd records width and direction",
          semantic.machine_argument & 0x1ffu, 4u | (1u << 8u));
    CHECK("semantic address32 outsd records DS and address width",
          (semantic.machine_argument >> 16u) & 0xffffu, 32u | (3u << 8u));
    CHECK("semantic FS rep outsb preserves the source segment override",
          lower_at(&string_port_image, 0x3584u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic FS rep outsb records FS in the physical descriptor",
          (semantic.machine_argument >> 24u) & 0xffu, 4u);

    static const pl_u8 summary_code[] = {
        0x48u, 0x0fu, 0xbdu, 0xc1u,       /* bsr rax, rcx */
        0x48u, 0x0fu, 0xbcu, 0xc1u,       /* bsf rax, rcx */
        0xf3u, 0x48u, 0x0fu, 0xbcu, 0xc1u,/* tzcnt rax, rcx */
        0xf3u, 0x48u, 0x0fu, 0xbdu, 0xc1u,/* lzcnt rax, rcx */
        0xf3u, 0x48u, 0x0fu, 0xb8u, 0xc1u,/* popcnt rax, rcx */
    };
    pl_x86_map summary_map = {
        summary_code, 0x3600u, sizeof summary_code,
        sizeof summary_code, 5u, 0u,
    };
    pl_x86_image summary_image = { &summary_map, 1u, 0u, 0x3600u };
    const pl_u64 summary_coordinates[] = {
        0x3600u, 0x3604u, 0x3608u, 0x360du, 0x3612u,
    };
    for (pl_u32 mode = 0u; mode < 5u; ++mode) {
        CHECK("semantic bit summary lowers",
              lower_at(&summary_image, summary_coordinates[mode],
                       storage, sizeof storage, &instruction, &semantic), 0);
        CHECK("semantic bit summary is one physical observation",
              semantic.plan.node_count, 1u);
        CHECK("semantic bit summary uses the shared physical lane",
              semantic.plan.nodes[0].opcode, PL_OPCODE_X86_BIT_SUMMARY);
        CHECK("semantic bit summary retains width and mode",
              semantic.plan.arguments[2].value, 64u | ((pl_u64)mode << 8u));
        CHECK("semantic bit summary publishes flags directly",
              semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 1u);
        CHECK("semantic bit summary publishes one result projection",
              semantic.plan.locals[0].kind, PL_OPERAND_PROJECTION);
    }

    static const pl_u8 double_shift_code[] = {
        0x48u, 0x0fu, 0xa4u, 0xc8u, 0x04u, /* shld rax, rcx, 4 */
        0x48u, 0x0fu, 0xadu, 0xc8u,        /* shrd rax, rcx, cl */
        0x48u, 0x0fu, 0xa5u, 0x08u,        /* shld [rax], rcx, cl */
    };
    pl_x86_map double_shift_map = {
        double_shift_code, 0x3620u, sizeof double_shift_code,
        sizeof double_shift_code, 5u, 0u,
    };
    pl_x86_image double_shift_image = {
        &double_shift_map, 1u, 0u, 0x3620u,
    };
    CHECK("semantic immediate shld lowers",
          lower_at(&double_shift_image, 0x3620u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic immediate shld is one flags/result observation",
          semantic.plan.node_count, 1u);
    CHECK("semantic immediate shld uses the double-shift lane",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_DOUBLE_SHIFT);
    CHECK("semantic immediate shld publishes the result projection",
          semantic.plan.locals[0].kind, PL_OPERAND_PROJECTION);
    CHECK("semantic dynamic shrd lowers",
          lower_at(&double_shift_image, 0x3625u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic dynamic shrd remains one physical observation",
          semantic.plan.node_count, 1u);
    CHECK("semantic memory shld lowers",
          lower_at(&double_shift_image, 0x3629u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory shld is load, quotient and conditional store",
          semantic.plan.node_count, 3u);
    CHECK("semantic memory shld does not materialize a zero-count write",
          semantic.plan.nodes[2].opcode, PL_OPCODE_MEMORY_STORE_IF);

    static const pl_u8 quotient_code[] = {
        0xc4u, 0xe2u, 0xf0u, 0xf2u, 0xc2u, /* andn rax, rcx, rdx */
        0x48u, 0x0fu, 0x38u, 0xf0u, 0x08u, /* movbe rcx, [rax] */
        0x48u, 0x0fu, 0x38u, 0xf1u, 0x08u, /* movbe [rax], rcx */
        0x48u, 0x0fu, 0xc3u, 0x08u,        /* movnti [rax], rcx */
        0x0fu, 0x18u, 0x08u,               /* prefetcht0 [rax] */
    };
    pl_x86_map quotient_map = {
        quotient_code, 0x3640u, sizeof quotient_code,
        sizeof quotient_code, 5u, 0u,
    };
    pl_x86_image quotient_image = { &quotient_map, 1u, 0u, 0x3640u };
    CHECK("semantic andn lowers",
          lower_at(&quotient_image, 0x3640u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic andn is one fused flags/result lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic andn reuses the common ALU quotient",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_ALU);
    CHECK("semantic andn selects complement-and mode",
          semantic.plan.arguments[3].value, 64u | (7u << 8u));
    CHECK("semantic movbe load lowers",
          lower_at(&quotient_image, 0x3645u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic movbe load is memory plus one byte permutation",
          semantic.plan.node_count, 2u);
    CHECK("semantic movbe store lowers",
          lower_at(&quotient_image, 0x364au, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic movbe store is one permutation plus memory",
          semantic.plan.node_count, 2u);
    CHECK("semantic movnti uses the ordinary physical store",
          lower_at(&quotient_image, 0x364fu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic movnti is one physical memory operation",
          semantic.plan.node_count, 1u);
    CHECK("semantic prefetch hint lowers to identity",
          lower_at(&quotient_image, 0x3653u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic prefetch hint has no false memory work",
          semantic.plan.node_count, 0u);
    CHECK("semantic prefetch hint has no false memory fault",
          !!(instruction.flags & PL_X86_INSTRUCTION_MAY_TRAP), 0);

    static const pl_u8 base_code[] = {
        0xf3u, 0x48u, 0x0fu, 0xaeu, 0xc0u, /* rdfsbase rax */
        0xf3u, 0x0fu, 0xaeu, 0xc8u,        /* rdgsbase eax */
        0xf3u, 0x48u, 0x0fu, 0xaeu, 0xd0u, /* wrfsbase rax */
        0xf3u, 0x0fu, 0xaeu, 0xd8u,        /* wrgsbase eax */
    };
    pl_x86_map base_map = {
        base_code, 0x3660u, sizeof base_code, sizeof base_code, 5u, 0u,
    };
    pl_x86_image base_image = { &base_map, 1u, 0u, 0x3660u };
    CHECK("semantic rdfsbase lowers",
          lower_at(&base_image, 0x3660u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic rdfsbase is a direct architectural projection",
          semantic.plan.node_count, 0u);
    CHECK("semantic rdfsbase publishes the canonical FS local",
          semantic.plan.locals[0].value, PL_X86_FS_BASE_LOCAL);
    CHECK("semantic rdgsbase eax lowers",
          lower_at(&base_image, 0x3665u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic rdgsbase eax has one zeroing publication",
          semantic.plan.node_count, 1u);
    CHECK("semantic wrfsbase lowers",
          lower_at(&base_image, 0x3669u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic wrfsbase publishes the GPR directly",
          semantic.plan.locals[PL_X86_FS_BASE_LOCAL].value, 0u);
    CHECK("semantic wrgsbase eax lowers",
          lower_at(&base_image, 0x366eu, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic wrgsbase eax zero-extends once",
          semantic.plan.node_count, 1u);

    static const pl_u8 crc_code[] = {
        0xf2u, 0x48u, 0x0fu, 0x38u, 0xf1u, 0xc1u, /* crc32 rax, rcx */
        0xf2u, 0x0fu, 0x38u, 0xf0u, 0x00u,        /* crc32 eax, [rax] */
    };
    pl_x86_map crc_map = {
        crc_code, 0x3680u, sizeof crc_code, sizeof crc_code, 5u, 0u,
    };
    pl_x86_image crc_image = { &crc_map, 1u, 0u, 0x3680u };
    CHECK("semantic register crc32 lowers",
          lower_at(&crc_image, 0x3680u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic register crc32 is one shared physical lane",
          semantic.plan.node_count, 1u);
    CHECK("semantic register crc32 uses the CRC32C quotient",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_CRC32);
    CHECK("semantic crc32 leaves flags untouched",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].kind, PL_OPERAND_LOCAL);
    CHECK("semantic memory-byte crc32 lowers",
          lower_at(&crc_image, 0x3686u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic memory-byte crc32 is load plus shared lane",
          semantic.plan.node_count, 2u);
    CHECK("semantic memory-byte crc32 carries the source width",
          semantic.plan.arguments[5].value, 8u);

    static const pl_u8 bzhi_code[] = {
        0xc4u, 0xe2u, 0xf0u, 0xf5u, 0xc2u, /* bzhi rax, rdx, rcx */
    };
    pl_x86_map bzhi_map = {
        bzhi_code, 0x36a0u, sizeof bzhi_code, sizeof bzhi_code, 5u, 0u,
    };
    pl_x86_image bzhi_image = { &bzhi_map, 1u, 0u, 0x36a0u };
    CHECK("semantic bzhi lowers",
          lower_at(&bzhi_image, 0x36a0u, storage, sizeof storage,
                   &instruction, &semantic), 0);
    CHECK("semantic bzhi is one flags/result observation",
          semantic.plan.node_count, 1u);
    CHECK("semantic bzhi uses the shared physical lane",
          semantic.plan.nodes[0].opcode, PL_OPCODE_X86_BZHI);
    CHECK("semantic bzhi publishes flags directly",
          semantic.plan.locals[PL_X86_RFLAGS_LOCAL].value, 1u);
    CHECK("semantic bzhi publishes one result projection",
          semantic.plan.locals[0].kind, PL_OPERAND_PROJECTION);

    static const pl_u8 block_code[] = {
        0x48u, 0x89u, 0xc8u,             /* mov rax, rcx */
        0x48u, 0x83u, 0xc0u, 0x01u,      /* add rax, 1 */
        0x75u, 0x02u,                    /* jnz target */
        0x90u, 0x90u, 0x90u,
    };
    pl_x86_map block_map = {
        block_code, 0x36c0u, sizeof block_code, sizeof block_code,
        5u, 0u,
    };
    pl_x86_image block_image = { &block_map, 1u, 0u, 0x36c0u };
    pl_x86_frontend block_frontend;
    CHECK("block frontend opens",
          pl_x86_frontend_open(&block_image, &block_frontend), 0);
    static pl_u8 block_first[1u << 17u];
    static pl_u8 block_second[1u << 17u];
    pl_x86_block_workspace block_workspace = {
        block_first, block_second, sizeof block_first, 32u,
    };
    pl_x86_block block;
    CHECK("straight line block lowers",
          pl_x86_block_lower(
              &block_frontend, 0x36c0u, &block_workspace, &block), 0);
    CHECK("straight line block consumes three source instructions",
          block.instruction_count, 3u);
    CHECK("straight line block ends at its exact source cut",
          block.end, 0x36c9u);
    CHECK("straight line block retains both conditional arms",
          block.successor_count, 2u);
    CHECK("straight line block retains branch target",
          block.successor[0], 0x36cbu);
    CHECK("straight line block retains fallthrough",
          block.successor[1], 0x36c9u);
    CHECK("straight line block retains a composed predicate",
          block.has_predicate, 1u);
    CHECK("straight line block projects its terminal condition",
          block.plan.node_count, 1u);
    CHECK("straight line block predicate is not a scalar lane",
          block.predicate.kind, PL_OPERAND_PROJECTION);
    CHECK("straight line block has no runtime operand stack",
          block.plan.stack_count, 0u);
    const pl_u32 branch_ranks[2] = { 7u, 9u };
    pl_wasm_block direct_block;
    CHECK("closed block binds both successor ranks",
          pl_x86_block_wasm(&block, branch_ranks, &direct_block), 0);
    CHECK("closed block keeps a direct conditional terminal",
          direct_block.has_branch_predicate, 1u);
    CHECK("closed block keeps the alternate successor rank",
          direct_block.alternate_result_payload, 9u);
    const pl_u32 mixed_ranks[2] = {
        7u, PL_X86_BLOCK_RESOLVE_RANK,
    };
    CHECK("closed block admits a page-resolved alternate arm",
          pl_x86_block_wasm(&block, mixed_ranks, &direct_block), 0);
    CHECK("closed block keeps its mapped primary arm direct",
          direct_block.result_kind, PL_VM_DIRECT);
    CHECK("closed block sends its outside arm to page dispatch",
          direct_block.alternate_result_kind, PL_VM_RESOLVE_RIP);
    CHECK("closed block resolved arm carries no invented rank",
          direct_block.alternate_result_payload, 0u);
    CHECK("closed block restores both direct ranks for emission",
          pl_x86_block_wasm(&block, branch_ranks, &direct_block), 0);
    CHECK("successor-free kernel factors static control",
          pl_x86_block_kernel_wasm(&block, &direct_block), 0);
    CHECK("successor-free kernel returns an ordered transition",
          direct_block.result_kind, PL_VM_TRANSITION);
    CHECK("successor-free kernel retains the alternate arm only as an outcome",
          direct_block.alternate_result_payload, 1u);
    CHECK("successor-free kernel contains no RIP delta",
          direct_block.next_rip, 0u);
    pl_wasm_module_spec direct_spec = { &direct_block, 1u, NULL, 0u };
    pl_u32 direct_bytes = 0u;
    CHECK("closed conditional block emits ordinary Wasm",
          pl_wasm_module_measure(&direct_spec, &direct_bytes), 0);
    CHECK("closed conditional block has a nonempty module",
          direct_bytes != 0u, 1);

    static const pl_u8 shadow_code[] = { 0xfbu, 0x90u, 0x90u };
    pl_x86_map shadow_map = {
        shadow_code, 0x36e0u, sizeof shadow_code, sizeof shadow_code,
        5u, 0u,
    };
    pl_x86_image shadow_image = { &shadow_map, 1u, 0u, 0x36e0u };
    pl_x86_frontend shadow_frontend;
    pl_x86_block shadow_block;
    static pl_u8 shadow_first[1u << 17u];
    static pl_u8 shadow_second[1u << 17u];
    pl_x86_block_workspace shadow_workspace = {
        shadow_first, shadow_second, sizeof shadow_first, 32u,
    };
    CHECK("interrupt-shadow frontend opens",
          pl_x86_frontend_open(&shadow_image, &shadow_frontend), 0);
    CHECK("interrupt-shadow successor lowers",
          pl_x86_block_lower(
              &shadow_frontend, 0x36e1u, &shadow_workspace, &shadow_block), 0);
    CHECK("interrupt-shadow successor is exactly one source instruction",
          shadow_block.instruction_count, 1u);
    CHECK("interrupt-shadow successor stops before the second nop",
          shadow_block.end, 0x36e2u);

    pl_x86_map block_alias_maps[2] = {
        block_map,
        { block_code, 0x46c0u, sizeof block_code, sizeof block_code,
          5u, 0u },
    };
    pl_x86_image block_alias_image = {
        block_alias_maps, 2u, 0u, 0x36c0u,
    };
    static pl_u8 block_compare_first[1u << 17u];
    static pl_u8 block_compare_second[1u << 17u];
    pl_x86_block_workspace block_comparison = {
        block_compare_first, block_compare_second,
        sizeof block_compare_first, 32u,
    };
    pl_x86_block_identity block_identities[16];
    pl_u32 block_hash_slots[32];
    pl_x86_block_builder block_builder;
    CHECK("block function interner opens",
          pl_x86_block_builder_open(
              &block_builder, &block_alias_image,
              &block_workspace, &block_comparison,
              block_identities, 16u, block_hash_slots, 32u), 0);
    pl_u32 original_block_rank = 0u;
    CHECK("block function interner admits normalized transfer",
          pl_x86_block_intern(
              &block_builder, &block, &original_block_rank), 0);
    pl_x86_instruction alias_instruction;
    CHECK("block function alias decodes",
          pl_x86_decode(
              &block_alias_image, 0x46c0u, &alias_instruction), 0);
    pl_u32 alias_block_rank = 0u;
    CHECK("block function alias forms and interns",
          pl_x86_block_rank_instruction(
              &alias_instruction, &block_builder, &alias_block_rank), 0);
    CHECK("equal normalized blocks share one function rank",
          alias_block_rank, original_block_rank);
    CHECK("block function identity uses complete equality",
          block_builder.identity_count, 1u);
    CHECK("block function interner records the shared coordinate",
          block_builder.shared, 1u);

    /* Refine the two alias pages as a complete residual machine.  The
     * workspace alternates two quotient maps; no 8,192-coordinate graph is
     * retained. */
    pl_x86_block_identity partition_identities[128];
    pl_u32 partition_block_hash[256];
    pl_x86_block_builder partition_builder;
    CHECK("closure partition block interner opens",
          pl_x86_block_builder_open(
              &partition_builder, &block_alias_image,
              &block_workspace, &block_comparison,
              partition_identities, 128u, partition_block_hash, 256u), 0);
    static pl_u32 partition_page_rows[2][2u * PL_ENTRY_PAGE_ROWS];
    static pl_u32 partition_tail_rows[2][32u * PL_ENTRY_TAIL_VALUES];
    static pl_u32 partition_tail_hash[2][64];
    static pl_closure_transfer_edge partition_edges[128];
    static pl_u64 partition_representatives[128];
    static pl_u32 partition_reverse_offsets[2u * PL_ENTRY_PAGE_VALUES + 1u];
    static pl_u32 partition_predecessors[4u * PL_ENTRY_PAGE_VALUES];
    static pl_u32 partition_classes[2u * PL_ENTRY_PAGE_VALUES];
    static pl_u32 partition_order[2u * PL_ENTRY_PAGE_VALUES];
    static pl_u32 partition_frontier[2u * PL_ENTRY_PAGE_VALUES];
    static pl_u32 partition_positions[2u * PL_ENTRY_PAGE_VALUES];
    static pl_u32 partition_class_starts[128];
    static pl_u32 partition_class_sizes[128];
    static pl_u32 partition_class_hits[128];
    static pl_u32 partition_touched[128];
    static pl_u32 partition_queue[256];
    static pl_u8 partition_queued[128];
    pl_closure_page partition_pages[2];
    pl_closure_partition_workspace partition_workspace = {
        .page_rows = { partition_page_rows[0], partition_page_rows[1] },
        .tail_rows = { partition_tail_rows[0], partition_tail_rows[1] },
        .tail_hash = { partition_tail_hash[0], partition_tail_hash[1] },
        .page_capacity = 2u,
        .tail_capacity = 32u,
        .tail_hash_slots = 64u,
        .pages = partition_pages,
        .transfer_edges = partition_edges,
        .transfer_edge_capacity = 128u,
        .representatives = partition_representatives,
        .class_capacity = 128u,
        .coordinate_capacity = 2u * PL_ENTRY_PAGE_VALUES,
        .predecessor_capacity = 4u * PL_ENTRY_PAGE_VALUES,
        .reverse_offsets = partition_reverse_offsets,
        .predecessors = partition_predecessors,
        .classes = partition_classes,
        .order = partition_order,
        .frontier = partition_frontier,
        .positions = partition_positions,
        .class_starts = partition_class_starts,
        .class_sizes = partition_class_sizes,
        .class_hits = partition_class_hits,
        .touched_classes = partition_touched,
        .split_queue = partition_queue,
        .queued_arms = partition_queued,
    };
    pl_entry_map partition_map;
    pl_closure_report partition_closure;
    pl_closure_partition_report partition_report;
    CHECK("closure reaches stable residual partition",
          pl_closure_partition(
              &block_alias_image, &partition_builder,
              &partition_workspace, &partition_map,
              &partition_closure, &partition_report), 0);
    CHECK("closure partition covers both complete pages",
          partition_closure.coordinates, 2u * PL_ENTRY_PAGE_VALUES);
    CHECK("closure partition processes exact predecessor splitters",
          partition_report.splitters != 0u, 1);
    CHECK("closure partition publishes every final class",
          partition_map.function_count, partition_report.classes);
    pl_u32 partition_left = 0u, partition_right = 0u;
    CHECK("closure partition reads first alias",
          pl_entry_map_lookup(
              &partition_map, partition_pages[0].entry_page_rank,
              0x6c0u, &partition_left), 0);
    CHECK("closure partition reads second alias",
          pl_entry_map_lookup(
              &partition_map, partition_pages[1].entry_page_rank,
              0x6c0u, &partition_right), 0);
    CHECK("residual partition preserves alias sharing",
          partition_left, partition_right);
    CHECK("residual class keeps an emitting representative",
          partition_representatives[partition_left] == 0x36c0u
              || partition_representatives[partition_left] == 0x46c0u,
          1);

    static const pl_u8 cut_code[] = {
        0x48u, 0x89u, 0xc8u,             /* mov rax, rcx */
        0x48u, 0xf7u, 0xf1u,             /* div rcx */
        0x48u, 0x83u, 0xc0u, 0x01u,      /* add rax, 1 */
    };
    pl_x86_map cut_map = {
        cut_code, 0x36e0u, sizeof cut_code, sizeof cut_code, 5u, 0u,
    };
    pl_x86_image cut_image = { &cut_map, 1u, 0u, 0x36e0u };
    pl_x86_frontend cut_frontend;
    CHECK("precise-cut frontend opens",
          pl_x86_frontend_open(&cut_image, &cut_frontend), 0);
    CHECK("block stops before a following precise fault",
          pl_x86_block_lower(
              &cut_frontend, 0x36e0u, &block_workspace, &block), 0);
    CHECK("pre-fault block contains only the preceding instruction",
          block.instruction_count, 1u);
    CHECK("pre-fault block dispatches to the faulting coordinate",
          block.successor[0], 0x36e3u);
    CHECK("faulting instruction lowers as its own block",
          pl_x86_block_lower(
              &cut_frontend, 0x36e3u, &block_workspace, &block), 0);
    CHECK("faulting block contains one source instruction",
          block.instruction_count, 1u);
    CHECK("faulting block retains the exact #DE predicate",
          block.has_fault_predicate, 1u);
}

static void fill_digest(pl_u8 digest[PL_EXECUTABLE_DIGEST_BYTES], pl_u8 seed)
{
    for (pl_u32 index = 0; index < PL_EXECUTABLE_DIGEST_BYTES; ++index)
        digest[index] = (pl_u8)(seed + index);
}

static int make_leaf_index(const pl_u8 *rows, pl_u32 row_bytes,
                           pl_u32 row_count, pl_u8 node[PL_INDEX_NODE_BYTES],
                           pl_u32 *node_bytes, pl_index_ref *ref)
{
    int status = pl_index_leaf_write(
        rows, row_bytes, row_count, node, PL_INDEX_NODE_BYTES, node_bytes);
    return status ? status
                  : pl_index_ref_from_node(node, *node_bytes, ref);
}

static void check_direct_executable(void)
{
    /* An eight-byte empty Wasm module is enough to prove that the executable
     * container carries directly instantiable code rather than an instruction
     * record interpreted by the VM. */
    static const pl_u8 wasm[] = {
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    };
    pl_u8 source_digest[PL_EXECUTABLE_DIGEST_BYTES];
    fill_digest(source_digest, 0x10u);
    pl_executable_binding bindings[2] = {
        {
            .virtual_page = 0x400000u,
            .generation = 7u,
            .source_offset = 0u,
            .source_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .dispatch_function = 0u,
            .dispatch_argument = 4u,
        },
        {
            .virtual_page = 0x401000u,
            .generation = 7u,
            .source_offset = PL_EXECUTABLE_PAGE_BYTES,
            .source_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .dispatch_function = 2u,
            .dispatch_argument = 5u,
        },
    };
    fill_digest(bindings[0].digest, 0x20u);
    fill_digest(bindings[1].digest, 0x40u);
    pl_executable_module modules[1] = { {
        .first_function = 0u,
        .payload_bytes = sizeof wasm,
        .function_count = 3u,
        .flags = PL_EXECUTABLE_MODULE_WASM32,
    } };
    pl_sha256_digest(wasm, sizeof wasm, modules[0].digest);
    pl_executable_resource resources[4] = {
        {
            .physical_address = 0u,
            .object_bytes = 2u << 20u,
            .mapped_bytes = 2u << 20u,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_MEMORY_BASE,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY
                   | PL_EXECUTABLE_RESOURCE_SPARSE,
        },
        {
            .physical_address = 1u << 20u,
            .object_bytes = 0x801u,
            .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_MEMORY_EXTENT,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address = PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_BASE,
            .object_bytes = PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES,
            .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address = PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_BASE,
            .object_bytes = PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES,
            .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
    };
    fill_digest(resources[0].digest, 0x70u);
    fill_digest(resources[1].digest, 0x90u);
    fill_digest(resources[2].digest, 0xb0u);
    fill_digest(resources[3].digest, 0xd0u);

    pl_u8 binding_rows[2][PL_EXECUTABLE_BINDING_BYTES];
    pl_u8 module_rows[1][PL_EXECUTABLE_MODULE_BYTES];
    pl_u8 resource_rows[4][PL_EXECUTABLE_RESOURCE_BYTES];
    for (pl_u32 index = 0u; index < 2u; ++index)
        CHECK("executable writes binding leaf row",
              pl_executable_binding_write(
                  &bindings[index], binding_rows[index]), 0);
    CHECK("executable writes module leaf row",
          pl_executable_module_write(&modules[0], module_rows[0]), 0);
    for (pl_u32 index = 0u; index < 4u; ++index)
        CHECK("executable writes resource leaf row",
              pl_executable_resource_write(
                  &resources[index], resource_rows[index]), 0);

    pl_u8 binding_node[PL_INDEX_NODE_BYTES];
    pl_u8 module_node[PL_INDEX_NODE_BYTES];
    pl_u8 resource_node[PL_INDEX_NODE_BYTES];
    pl_u32 binding_node_bytes = 0u, module_node_bytes = 0u;
    pl_u32 resource_node_bytes = 0u;
    pl_index_ref binding_index, module_index, resource_index;
    CHECK("executable builds binding index",
          make_leaf_index(
              binding_rows[0], PL_EXECUTABLE_BINDING_BYTES, 2u,
              binding_node, &binding_node_bytes, &binding_index), 0);
    CHECK("executable builds module index",
          make_leaf_index(
              module_rows[0], PL_EXECUTABLE_MODULE_BYTES, 1u,
              module_node, &module_node_bytes, &module_index), 0);
    CHECK("executable builds resource index",
          make_leaf_index(
              resource_rows[0], PL_EXECUTABLE_RESOURCE_BYTES, 4u,
              resource_node, &resource_node_bytes, &resource_index), 0);

    pl_u64 external_bytes = sizeof wasm + resources[0].object_bytes
                          + resources[1].object_bytes
                          + resources[2].object_bytes
                          + resources[3].object_bytes;
    pl_executable_state initial_state = {
        .rip = 0x400080u,
        .rflags = 2u,
        .cr0 = 0x80000011u,
        .cr3 = 0x1000u,
        .cr4 = 0x20u,
        .efer = 0x500u,
        .msr_count = 1u,
        .mxcsr = 0x1f80u,
        .msr_keys = { 0xc0000100u },
        .msr_values = { 0x7fff0000u },
        .x87_control = 0x037fu,
        .x87_tag = 0xffffu,
    };
    initial_state.registers[4] = 0x8000u;
    initial_state.system[2] = 0x10u;
    initial_state.x87_significand[0] = 0x8000000000000000ull;
    initial_state.x87_sign_exponent[0] = 0x3fffu;
    pl_executable_spec spec = {
        .entry_rip = 0x400080u,
        .entry_generation = 7u,
        .entry_function = 1u,
        .function_count = 3u,
        .source_bytes = 2u * PL_EXECUTABLE_PAGE_BYTES,
        .source_digest = source_digest,
        .memory_bytes = resources[0].mapped_bytes,
        .external_bytes = external_bytes,
        .entry_page_count = 1u,
        .entry_tail_row_count = 1u,
        .state = &initial_state,
        .bindings = &binding_index,
        .modules = &module_index,
        .resources = &resource_index,
    };

    pl_u64 measured = 0;
    CHECK("direct executable measures", pl_executable_measure(&spec, &measured),
          0);
    CHECK("direct executable fixed root bytes", measured,
          PL_EXECUTABLE_HEADER_BYTES);

    pl_u8 bytes[PL_EXECUTABLE_HEADER_BYTES];
    pl_u64 written = 0;
    CHECK("direct executable writes",
          pl_executable_write(&spec, bytes, sizeof bytes, &written), 0);
    CHECK("direct executable measured equals written", written, measured);

    pl_executable executable;
    CHECK("direct executable opens",
          pl_executable_open(bytes, written, &executable), 0);
    CHECK("direct executable entry", executable.entry_rip, spec.entry_rip);
    CHECK("direct executable functions", executable.function_count, 3u);
    CHECK("direct executable external bytes", executable.external_bytes,
          external_bytes);
    CHECK("direct executable binding identities",
          executable.bindings.rows, 2u);
    CHECK("direct executable resource identities",
          executable.resources.rows, 4u);
    CHECK("direct executable entry pages", executable.entry_page_count, 1u);
    CHECK("direct executable entry tails",
          executable.entry_tail_row_count, 1u);
    CHECK("direct executable source digest",
          memcmp(executable.source_digest, source_digest,
                 PL_EXECUTABLE_DIGEST_BYTES), 0);
    CHECK("direct executable initial RIP", executable.state.rip,
          initial_state.rip);
    CHECK("direct executable initial RSP", executable.state.registers[4],
          initial_state.registers[4]);
    CHECK("direct executable initial FS base",
          executable.state.msr_values[0], initial_state.msr_values[0]);
    CHECK("direct executable x87 significand is canonical state",
          executable.state.x87_significand[0],
          initial_state.x87_significand[0]);
    CHECK("direct executable x87 exponent is canonical state",
          executable.state.x87_sign_exponent[0],
          initial_state.x87_sign_exponent[0]);
    CHECK("direct executable x87 control survives root roundtrip",
          executable.state.x87_control, initial_state.x87_control);
    CHECK("direct executable x87 tags survive root roundtrip",
          executable.state.x87_tag, initial_state.x87_tag);
    CHECK("direct executable MXCSR survives root roundtrip",
          executable.state.mxcsr, initial_state.mxcsr);

    pl_index_node opened_index;
    CHECK("direct executable opens selected binding leaf",
          pl_index_node_open(
              &executable.bindings, binding_node, binding_node_bytes,
              &opened_index), 0);
    const pl_u8 *selected = NULL;
    CHECK("direct executable finds exact generation",
          pl_index_find_row(
              &opened_index, (pl_index_key){ 0x401000u, 7u }, &selected), 0);
    CHECK("direct executable stale generation is absent",
          pl_index_find_row(
              &opened_index, (pl_index_key){ 0x401000u, 8u }, &selected),
          PL_ERROR_INDEX_ABSENT);
    pl_executable_binding binding;
    CHECK("direct executable reads selected binding",
          pl_executable_binding_read(selected, &binding), 0);
    CHECK("direct executable validates selected binding",
          pl_executable_binding_validate(
              &binding, executable.source_bytes,
              executable.function_count), 0);
    CHECK("direct executable dispatch function", binding.dispatch_function,
          2u);
    CHECK("direct executable dispatch argument", binding.dispatch_argument,
          5u);
    pl_executable_module module;
    CHECK("direct executable opens selected module leaf",
          pl_index_node_open(
              &executable.modules, module_node, module_node_bytes,
              &opened_index), 0);
    CHECK("direct executable finds module row",
          pl_index_find_row(
              &opened_index, (pl_index_key){ 0u, 0u }, &selected), 0);
    CHECK("direct executable reads module",
          pl_executable_module_read(selected, &module), 0);
    CHECK("direct executable validates module range",
          pl_executable_module_validate(
              &module, executable.function_count), 0);
    CHECK("direct executable module functions", module.function_count, 3u);
    CHECK("external Wasm payload validates",
          pl_executable_validate_module_payload(&module, wasm, sizeof wasm),
          0);
    CHECK("truncated external Wasm payload is rejected",
          pl_executable_validate_module_payload(&module, wasm,
                                                sizeof wasm - 1u),
          PL_ERROR_EXECUTABLE_MODULE);
    pl_executable_resource resource;
    CHECK("direct executable opens selected resource leaf",
          pl_index_node_open(
              &executable.resources, resource_node, resource_node_bytes,
              &opened_index), 0);
    CHECK("direct executable finds cold extent",
          pl_index_find_row(
              &opened_index, (pl_index_key){ 1u << 20u, 0u }, &selected), 0);
    CHECK("direct executable reads cold extent",
          pl_executable_resource_read(selected, &resource), 0);
    CHECK("direct executable validates cold extent",
          pl_executable_resource_validate(
              &resource, executable.memory_bytes), 0);
    CHECK("cold extent keeps physical coordinate",
          resource.physical_address, 1u << 20u);
    CHECK("cold extent keeps exact object bytes",
          resource.object_bytes, 0x801u);
    CHECK("cold extent accepts exact authenticated object",
          pl_executable_validate_resource_extent(
              &resource, resource.object_bytes), 0);
    CHECK("cold extent rejects a truncated object",
          pl_executable_validate_resource_extent(
              &resource, resource.object_bytes - 1u),
          PL_ERROR_EXECUTABLE_RESOURCE);

    pl_vm_result direct = pl_vm_direct(37u);
    CHECK("direct result kind", pl_vm_result_kind(direct), PL_VM_DIRECT);
    CHECK("direct result rank", pl_vm_result_payload(direct), 37u);
    pl_vm_result fault = pl_vm_result_make(PL_VM_FAULT, 6u);
    CHECK("fault result kind", pl_vm_result_kind(fault), PL_VM_FAULT);
    CHECK("fault result vector", pl_vm_result_payload(fault), 6u);
    CHECK("direct executable context size",
          sizeof(pl_vm_executable_context), PL_VM_EXECUTABLE_CONTEXT_BYTES);

    pl_projection projection = {
        .source_bytes = spec.source_bytes,
        .entry_rip = spec.entry_rip,
        .entry_residual = 1u,
        .function_count = spec.function_count,
        .instantiation_count = 2u,
        .parameter_word_count = 3u,
        .residual_count = 4u,
        .residual_edge_count = 5u,
        .entry_page_count = spec.entry_page_count,
        .entry_tail_row_count = spec.entry_tail_row_count,
        .modules = module_index,
        .resources = resource_index,
        .bindings = binding_index,
    };
    memcpy(projection.source_digest, source_digest,
           PL_EXECUTABLE_DIGEST_BYTES);
    pl_u8 projection_bytes[PL_PROJECTION_HEADER_BYTES];
    CHECK("direct projection writes",
          pl_projection_write(&projection, projection_bytes), 0);
    pl_projection opened_projection;
    CHECK("direct projection opens",
          pl_projection_open(
              projection_bytes, sizeof projection_bytes,
              &opened_projection), 0);
    CHECK("direct projection keeps topology count",
          opened_projection.function_count, spec.function_count);
    CHECK("direct projection keeps exact identity count",
          opened_projection.instantiation_count, 2u);
    projection_bytes[PL_PROJECTION_HEADER_BYTES - 1u] = 1u;
    CHECK("direct projection rejects noncanonical tail",
          pl_projection_open(
              projection_bytes, sizeof projection_bytes,
              &opened_projection), PL_ERROR_PROJECTION);

    /* Structural mutations must fail before anything is published. */
    pl_u32 saved = pl_read_u32(bytes + PL_EXECUTABLE_OFF_FLAGS);
    pl_write_u32(bytes + PL_EXECUTABLE_OFF_FLAGS, 0u);
    CHECK("non-total executable is rejected",
          pl_executable_open(bytes, written, &executable),
          PL_ERROR_EXECUTABLE);
    pl_write_u32(bytes + PL_EXECUTABLE_OFF_FLAGS, saved);

    pl_write_u32(bytes + PL_EXECUTABLE_OFF_ENTRY_FUNCTION, 4u);
    CHECK("entry function outside closure is rejected",
          pl_executable_open(bytes, written, &executable),
          PL_ERROR_EXECUTABLE_ABI);
    pl_write_u32(bytes + PL_EXECUTABLE_OFF_ENTRY_FUNCTION, 1u);

    pl_u32 binding_width = pl_read_u32(
        bytes + PL_EXECUTABLE_OFF_BINDING_INDEX + 48u);
    pl_write_u32(bytes + PL_EXECUTABLE_OFF_BINDING_INDEX + 48u,
                 binding_width + 1u);
    CHECK("wrong binding leaf width is rejected",
          pl_executable_open(bytes, written, &executable),
          PL_ERROR_EXECUTABLE);
    pl_write_u32(bytes + PL_EXECUTABLE_OFF_BINDING_INDEX + 48u,
                 binding_width);

    pl_u8 corrupt_wasm[sizeof wasm];
    memcpy(corrupt_wasm, wasm, sizeof wasm);
    corrupt_wasm[1u] = 'x';
    CHECK("invalid Wasm module is rejected",
          pl_executable_validate_module_payload(&module, corrupt_wasm,
                                                sizeof corrupt_wasm),
          PL_ERROR_EXECUTABLE_MODULE);

    pl_u8 reversed[2][PL_EXECUTABLE_BINDING_BYTES];
    CHECK("reversed binding row 0 encodes",
          pl_executable_binding_write(&bindings[1], reversed[0]), 0);
    CHECK("reversed binding row 1 encodes",
          pl_executable_binding_write(&bindings[0], reversed[1]), 0);
    CHECK("unsorted page generations are rejected by leaf writer",
          pl_index_leaf_write(
              reversed[0], PL_EXECUTABLE_BINDING_BYTES, 2u,
              binding_node, sizeof binding_node, &binding_node_bytes),
          PL_ERROR_INDEX);
}

static void check_entry_map(void)
{
    pl_u32 page_rows[3u * PL_ENTRY_PAGE_ROWS];
    pl_u32 tail_rows[4u * PL_ENTRY_TAIL_VALUES];
    pl_u32 hash_slots[8];
    pl_u32 functions[PL_ENTRY_PAGE_VALUES];
    pl_entry_map_builder builder;
    CHECK("entry map builder opens",
          pl_entry_map_builder_open(
              &builder, page_rows, 3u, tail_rows, 4u, hash_slots, 8u, 16u),
          0);

    /* All sixteen high-nibble rows have the same complete future. */
    for (pl_u32 offset = 0; offset < PL_ENTRY_PAGE_VALUES; ++offset)
        functions[offset] = offset & 7u;
    pl_u32 first_page = 99u;
    CHECK("entry map adds first page",
          pl_entry_map_add_page(&builder, functions, &first_page), 0);
    CHECK("entry map first page rank", first_page, 0u);
    CHECK("entry map shares equal tail rows", builder.tail_row_count, 1u);

    /* One changed 256-coordinate region adds exactly one physical row. */
    for (pl_u32 low = 0; low < PL_ENTRY_TAIL_VALUES; ++low)
        functions[3u * PL_ENTRY_TAIL_VALUES + low] = 9u;
    pl_u32 second_page = 99u;
    CHECK("entry map adds second page",
          pl_entry_map_add_page(&builder, functions, &second_page), 0);
    CHECK("entry map second page rank", second_page, 1u);
    CHECK("entry map adds only changed row", builder.tail_row_count, 2u);

    pl_entry_map map;
    pl_entry_map_finish(&builder, &map);
    pl_u32 function = 99u;
    CHECK("entry map first direct lookup",
          pl_entry_map_lookup(&map, first_page, 0x3a5u, &function), 0);
    CHECK("entry map first direct result", function, 5u);
    CHECK("entry map changed direct lookup",
          pl_entry_map_lookup(&map, second_page, 0x3a5u, &function), 0);
    CHECK("entry map changed direct result", function, 9u);
    CHECK("entry map page bounds",
          pl_entry_map_lookup(&map, 2u, 0u, &function),
          PL_ERROR_ENTRY_MAP);

    /* Failure after admitting some new rows rolls the whole page back. */
    for (pl_u32 offset = 0; offset < PL_ENTRY_PAGE_VALUES; ++offset)
        functions[offset] = ((offset >> PL_ENTRY_TAIL_BITS)
                             + (offset & 15u)) & 15u;
    pl_u32 rejected_page = 99u;
    CHECK("entry map capacity failure",
          pl_entry_map_add_page(&builder, functions, &rejected_page),
          PL_ERROR_ENTRY_MAP_FULL);
    CHECK("entry map failed page is not published", builder.page_count, 2u);
    CHECK("entry map failed rows roll back", builder.tail_row_count, 2u);

    for (pl_u32 offset = 0; offset < PL_ENTRY_PAGE_VALUES; ++offset)
        functions[offset] = offset & 7u;
    functions[0] = 16u;
    CHECK("entry map rejects out-of-domain function rank",
          pl_entry_map_add_page(&builder, functions, &rejected_page),
          PL_ERROR_ENTRY_MAP);
    CHECK("entry map invalid page is not published", builder.page_count, 2u);

    /* The cleared hash slots still admit a known row afterwards. */
    for (pl_u32 offset = 0; offset < PL_ENTRY_PAGE_VALUES; ++offset)
        functions[offset] = offset & 7u;
    pl_u32 third_page = 99u;
    CHECK("entry map resumes after rollback",
          pl_entry_map_add_page(&builder, functions, &third_page), 0);
    CHECK("entry map resumed page rank", third_page, 2u);
    CHECK("entry map duplicate remains shared", builder.tail_row_count, 2u);

    pl_entry_map_finish(&builder, &map);
    pl_entry_map_page_writer page_writer;
    CHECK("entry map delivery validates once",
          pl_entry_map_page_writer_open(&page_writer, &map), 0);
    pl_u8 page_bytes[PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES];
    CHECK("entry map page writes",
          pl_entry_map_page_writer_write(
              &page_writer, second_page, page_bytes), 0);
    CHECK("entry map page opens",
          pl_entry_map_page_open(page_bytes, map.tail_row_count), 0);
    CHECK("entry map page row roundtrip",
          pl_read_u32(page_bytes + 3u * 4u), 1u);
    pl_u8 tail_bytes[PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES];
    CHECK("entry map tail writes",
          pl_entry_map_tail_writer_write(
              &page_writer, 1u, tail_bytes), 0);
    CHECK("entry map tail opens",
          pl_entry_map_tail_open(tail_bytes, map.function_count), 0);
    CHECK("entry map tail value roundtrip",
          pl_read_u32(tail_bytes + 0xa5u * 4u), 9u);
    pl_write_u32(tail_bytes, map.function_count);
    CHECK("entry map tail rejects out-of-domain rank",
          pl_entry_map_tail_open(tail_bytes, map.function_count),
          PL_ERROR_ENTRY_MAP);

    pl_entry_map_builder invalid;
    CHECK("entry map requires power-of-two hash table",
          pl_entry_map_builder_open(
              &invalid, page_rows, 1u, tail_rows, 1u, hash_slots, 3u, 1u),
          PL_ERROR_ENTRY_MAP);
}

static void check_residual_graph(void)
{
    pl_u32 kernels[5];
    pl_u64 zero_bits[1], two_bits[1];
    pl_u32 zero_prefix[2], two_prefix[2];
    pl_u32 edge_next[6];
    pl_i32 edge_delta[6];
    pl_residual_builder builder;
    CHECK("residual builder opens",
          pl_residual_builder_open(
              &builder, kernels, 5u, zero_bits, two_bits,
              zero_prefix, two_prefix, 1u,
              edge_next, edge_delta, 6u), 0);

    const pl_u32 next0[2] = { 1u, 0u };
    const pl_i32 delta0[2] = { 4, 0 };
    const pl_u32 next1[2] = { 2u, 3u };
    const pl_i32 delta1[2] = { 5, -7 };
    const pl_u32 next3[2] = { 4u, 0u };
    const pl_i32 delta3[2] = { 8, 0 };
    const pl_u32 next4[2] = { 0u, 2u };
    const pl_i32 delta4[2] = { -9, 11 };
    pl_u32 rank = 99u;
    CHECK("residual state zero adds",
          pl_residual_add(&builder, 0u, 1u, next0, delta0, &rank), 0);
    CHECK("residual state zero rank", rank, 0u);
    CHECK("residual state one adds",
          pl_residual_add(&builder, 1u, 2u, next1, delta1, &rank), 0);
    CHECK("residual terminal state adds",
          pl_residual_add(&builder, 2u, 0u, NULL, NULL, &rank), 0);
    CHECK("residual state three adds",
          pl_residual_add(&builder, 0u, 1u, next3, delta3, &rank), 0);
    CHECK("residual state four adds",
          pl_residual_add(&builder, 1u, 2u, next4, delta4, &rank), 0);

    pl_residual_graph graph;
    CHECK("residual graph finishes",
          pl_residual_finish(&builder, 3u, &graph), 0);
    CHECK("residual graph stores five states", graph.state_count, 5u);
    CHECK("degree bitplanes imply six edges", graph.edge_count, 6u);
    CHECK("zero-degree bit is exact", zero_bits[0], 1ull << 2u);
    CHECK("two-degree bits are exact",
          two_bits[0], (1ull << 1u) | (1ull << 4u));

    pl_u32 kernel = 99u, degree = 99u, base = 99u;
    CHECK("residual state four resolves",
          pl_residual_state(&graph, 4u, &kernel, &degree, &base), 0);
    CHECK("residual state kernel projects", kernel, 1u);
    CHECK("residual state degree projects", degree, 2u);
    CHECK("rank-derived edge base skips no-edge state", base, 4u);
    pl_u32 next = 99u;
    pl_i32 delta = 99;
    CHECK("selected residual edge resolves",
          pl_residual_edge(&graph, 4u, 1u, &next, &delta), 0);
    CHECK("selected residual edge target", next, 2u);
    CHECK("selected residual edge RIP delta", delta, 11);
    CHECK("residual edge rejects an absent arm",
          pl_residual_edge(&graph, 2u, 0u, &next, &delta),
          PL_ERROR_RESIDUAL);

    pl_u8 state_page[PL_RESIDUAL_PAGE_BYTES];
    CHECK("canonical residual state page writes",
          pl_residual_state_page_write(&graph, 0u, state_page), 0);
    CHECK("canonical residual state page opens",
          pl_residual_state_page_open(
              state_page, 0u, graph.state_count,
              graph.edge_count, graph.kernel_count), 0);
    kernel = degree = base = 99u;
    CHECK("state page kernel is direct u24 projection",
          pl_residual_state_page_kernel(state_page, 4u, &kernel), 0);
    CHECK("state page kernel roundtrip", kernel, 1u);
    CHECK("state page rank derives selected edge base",
          pl_residual_state_page_edge_base(
              state_page, 4u, &degree, &base), 0);
    CHECK("state page degree roundtrip", degree, 2u);
    CHECK("state page edge base roundtrip", base, 4u);
    state_page[PL_RESIDUAL_PAGE_BYTES - 1u] = 1u;
    CHECK("state page rejects noncanonical unused tail",
          pl_residual_state_page_open(
              state_page, 0u, graph.state_count,
              graph.edge_count, graph.kernel_count),
          PL_ERROR_RESIDUAL);

    pl_u8 edge_page[PL_RESIDUAL_PAGE_BYTES];
    CHECK("canonical residual edge page writes",
          pl_residual_edge_page_write(&graph, 0u, edge_page), 0);
    CHECK("canonical residual edge page opens",
          pl_residual_edge_page_open(
              edge_page, 0u, graph.state_count, graph.edge_count), 0);
    next = 99u;
    delta = 99;
    CHECK("edge page selected arm reads",
          pl_residual_edge_page_get(edge_page, 5u, &next, &delta), 0);
    CHECK("edge page next residual roundtrip", next, 2u);
    CHECK("edge page signed RIP delta roundtrip", delta, 11);
}

static void check_instantiation_pages(void)
{
    pl_u32 topologies[3] = { 2u, 1u, 2u };
    pl_u32 offsets[3] = { 0u, 2u, 2u };
    pl_u8 counts[3] = { 2u, 0u, 3u };
    pl_u64 parameters[5] = { 11u, 13u, 17u, 19u, 23u };
    pl_instantiation_table table = {
        .topologies = topologies,
        .parameter_offsets = offsets,
        .parameter_counts = counts,
        .parameters = parameters,
        .instantiation_count = 3u,
        .topology_count = 3u,
        .parameter_word_count = 5u,
    };
    CHECK("packed instantiation table validates",
          pl_instantiation_validate(&table), 0);

    pl_u8 page[PL_INSTANTIATION_PAGE_BYTES];
    CHECK("canonical instantiation page writes",
          pl_instantiation_page_write(&table, 0u, page), 0);
    CHECK("canonical instantiation page opens",
          pl_instantiation_page_open(
              page, 0u, table.instantiation_count, table.topology_count,
              table.parameter_word_count, 0u), 0);
    pl_u32 topology = 99u, first = 99u, count = 99u;
    CHECK("instantiation row reads",
          pl_instantiation_page_get(
              page, 2u, &topology, &first, &count), 0);
    CHECK("instantiation topology roundtrip", topology, 2u);
    CHECK("instantiation parameter offset roundtrip", first, 2u);
    CHECK("instantiation parameter count roundtrip", count, 3u);
    CHECK("instantiation page authenticates preceding parameter prefix",
          pl_instantiation_page_open(
              page, 0u, table.instantiation_count, table.topology_count,
              table.parameter_word_count, 1u),
          PL_ERROR_INSTANTIATION);

    pl_u32 row_two_offset = PL_INSTANTIATION_PAGE_HEADER
                          + 2u * PL_INSTANTIATION_ROW_BYTES + 3u;
    page[row_two_offset] = 3u;
    CHECK("instantiation page rejects a parameter gap",
          pl_instantiation_page_open(
              page, 0u, table.instantiation_count, table.topology_count,
              table.parameter_word_count, 0u),
          PL_ERROR_INSTANTIATION);
    page[row_two_offset] = 2u;
    page[PL_INSTANTIATION_PAGE_BYTES - 1u] = 1u;
    CHECK("instantiation page rejects noncanonical unused tail",
          pl_instantiation_page_open(
              page, 0u, table.instantiation_count, table.topology_count,
              table.parameter_word_count, 0u),
          PL_ERROR_INSTANTIATION);

    pl_u8 parameter_page[PL_PARAMETER_PAGE_BYTES];
    CHECK("canonical parameter page writes",
          pl_parameter_page_write(&table, 0u, parameter_page), 0);
    CHECK("canonical parameter page opens",
          pl_parameter_page_open(
              parameter_page, 0u, table.parameter_word_count), 0);
    pl_u64 value = 0u;
    CHECK("parameter word reads",
          pl_parameter_page_get(parameter_page, 4u, &value), 0);
    CHECK("parameter word roundtrip", value, 23u);
    parameter_page[PL_PARAMETER_PAGE_BYTES - 1u] = 1u;
    CHECK("parameter page rejects noncanonical unused tail",
          pl_parameter_page_open(
              parameter_page, 0u, table.parameter_word_count),
          PL_ERROR_INSTANTIATION);

    offsets[2] = 3u;
    CHECK("instantiation table rejects a parameter gap",
          pl_instantiation_validate(&table), PL_ERROR_INSTANTIATION);
}

typedef struct {
    pl_u32 objects;
    pl_u64 bytes;
} index_publish_probe;

static int probe_index_publish(void *opaque,
                               const pl_u8 digest[PL_SHA256_BYTES],
                               const pl_u8 *bytes, pl_u32 length)
{
    index_publish_probe *probe = opaque;
    pl_u8 observed[PL_SHA256_BYTES];
    pl_sha256_digest(bytes, length, observed);
    if (memcmp(observed, digest, PL_SHA256_BYTES))
        return PL_ERROR_INDEX_DIGEST;
    ++probe->objects;
    probe->bytes += length;
    return 0;
}

static void check_authenticated_index(void)
{
    static const pl_u8 EMPTY_DIGEST[PL_SHA256_BYTES] = {
        0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14,
        0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
        0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c,
        0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55,
    };
    static const pl_u8 ABC_DIGEST[PL_SHA256_BYTES] = {
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
        0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
        0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
        0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
    };
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256_digest((const pl_u8 *)"", 0u, digest);
    CHECK("SHA-256 empty vector",
          memcmp(digest, EMPTY_DIGEST, sizeof digest), 0);
    pl_sha256 state;
    pl_sha256_open(&state);
    pl_sha256_write(&state, (const pl_u8 *)"a", 1u);
    pl_sha256_write(&state, (const pl_u8 *)"bc", 2u);
    pl_sha256_close(&state, digest);
    CHECK("SHA-256 incremental vector",
          memcmp(digest, ABC_DIGEST, sizeof digest), 0);

    pl_u8 rows[5][24] = { { 0 } };
    const pl_u64 keys[5] = { 1u, 2u, 3u, 7u, 9u };
    for (pl_u32 index = 0u; index < 5u; ++index) {
        pl_write_u64(rows[index], keys[index]);
        pl_write_u64(rows[index] + 8u, 0u);
        pl_write_u64(rows[index] + 16u, 100u + index);
    }
    pl_u8 first_leaf[PL_INDEX_NODE_BYTES];
    pl_u8 second_leaf[PL_INDEX_NODE_BYTES];
    pl_u8 branch[PL_INDEX_NODE_BYTES];
    pl_u32 first_bytes = 0u, second_bytes = 0u, branch_bytes = 0u;
    CHECK("index writes first leaf",
          pl_index_leaf_write(rows[0], sizeof rows[0], 3u,
                              first_leaf, sizeof first_leaf, &first_bytes), 0);
    CHECK("index writes second leaf",
          pl_index_leaf_write(rows[3], sizeof rows[0], 2u,
                              second_leaf, sizeof second_leaf, &second_bytes),
          0);
    pl_index_ref leaves[2];
    CHECK("index names first leaf",
          pl_index_ref_from_node(first_leaf, first_bytes, &leaves[0]), 0);
    CHECK("index names second leaf",
          pl_index_ref_from_node(second_leaf, second_bytes, &leaves[1]), 0);
    CHECK("index writes branch",
          pl_index_branch_write(leaves, 2u, branch, sizeof branch,
                                &branch_bytes), 0);
    pl_index_ref root;
    CHECK("index names branch",
          pl_index_ref_from_node(branch, branch_bytes, &root), 0);
    CHECK("index branch level", root.level, 1u);
    CHECK("index branch total rows", root.rows, 5u);

    /* The production writer retains only the leaf-reference frontier.  Four
     * hundred rows require three leaf objects and one branch, without an
     * object graph or a second copy of the rows. */
    pl_u8 many_rows[400][24] = { { 0u } };
    for (pl_u32 index = 0u; index < 400u; ++index) {
        pl_write_u64(many_rows[index], index);
        pl_write_u64(many_rows[index] + 8u, 0u);
        pl_write_u64(many_rows[index] + 16u, index * 3u);
    }
    pl_index_ref frontier[3];
    pl_u8 build_node[PL_INDEX_NODE_BYTES];
    pl_index_ref built_root;
    index_publish_probe probe = { 0u, 0u };
    CHECK("index builds bounded canonical tree",
          pl_index_build(
              many_rows[0], sizeof many_rows[0], 400u,
              frontier, 3u, build_node,
              probe_index_publish, &probe, &built_root), 0);
    CHECK("index builder publishes three leaves and root", probe.objects, 4u);
    CHECK("index builder root level", built_root.level, 1u);
    CHECK("index builder preserves all rows", built_root.rows, 400u);
    CHECK("index builder first coordinate", built_root.first.major, 0u);
    CHECK("index builder last coordinate", built_root.last.major, 399u);
    CHECK("index builder rejects a short frontier",
          pl_index_build(
              many_rows[0], sizeof many_rows[0], 400u,
              frontier, 2u, build_node,
              probe_index_publish, &probe, &built_root),
          PL_ERROR_INDEX_RANGE);

    pl_index_node root_node;
    CHECK("index authenticates branch",
          pl_index_node_open(&root, branch, branch_bytes, &root_node), 0);
    pl_index_ref selected;
    CHECK("index selects touched leaf",
          pl_index_select_child(
              &root_node, (pl_index_key){ 7u, 0u }, &selected), 0);
    CHECK("index selected leaf identity",
          memcmp(selected.digest, leaves[1].digest, PL_SHA256_BYTES), 0);
    pl_index_node leaf_node;
    CHECK("index authenticates selected leaf",
          pl_index_node_open(
              &selected, second_leaf, second_bytes, &leaf_node), 0);
    const pl_u8 *found = NULL;
    CHECK("index finds exact row",
          pl_index_find_row(
              &leaf_node, (pl_index_key){ 7u, 0u }, &found), 0);
    CHECK("index row payload", pl_read_u64(found + 16u), 103u);
    CHECK("index rejects absent gap",
          pl_index_select_child(
              &root_node, (pl_index_key){ 6u, 0u }, &selected),
          PL_ERROR_INDEX_ABSENT);
    CHECK("index predecessor selects prior leaf across gap",
          pl_index_select_floor_child(
              &root_node, (pl_index_key){ 6u, 0u }, &selected), 0);
    CHECK("index predecessor leaf identity",
          memcmp(selected.digest, leaves[0].digest, PL_SHA256_BYTES), 0);
    CHECK("index authenticates predecessor leaf",
          pl_index_node_open(
              &selected, first_leaf, first_bytes, &leaf_node), 0);
    CHECK("index finds predecessor row",
          pl_index_find_floor(
              &leaf_node, (pl_index_key){ 6u, 0u }, &found), 0);
    CHECK("index predecessor row payload", pl_read_u64(found + 16u), 102u);
    CHECK("index rejects predecessor below first key",
          pl_index_find_floor(
              &leaf_node, (pl_index_key){ 0u, 0u }, &found),
          PL_ERROR_INDEX_ABSENT);

    first_leaf[first_bytes - 1u] ^= 1u;
    CHECK("index rejects unauthenticated node",
          pl_index_node_open(
              &leaves[0], first_leaf, first_bytes, &leaf_node),
          PL_ERROR_INDEX_DIGEST);
    first_leaf[first_bytes - 1u] ^= 1u;

    pl_write_u64(rows[1], 1u);
    CHECK("index rejects duplicate key",
          pl_index_leaf_write(rows[0], sizeof rows[0], 3u,
                              first_leaf, sizeof first_leaf, &first_bytes),
          PL_ERROR_INDEX);
    pl_write_u64(rows[1], 2u);

    pl_index_ref overlap[2] = { leaves[0], leaves[1] };
    overlap[1].first = overlap[0].last;
    CHECK("index rejects overlapping children",
          pl_index_branch_write(overlap, 2u, branch, sizeof branch,
                                &branch_bytes), PL_ERROR_INDEX);
}

static void check_wasm_emitter(void)
{
    pl_node node = { PL_OPCODE_ADD, 0u, 2u };
    pl_operand arguments[5] = {
        { PL_OPERAND_LOCAL, 0u },
        { PL_OPERAND_CONST, 42u },
        { PL_OPERAND_CONST, 0u },
        { PL_OPERAND_CONST, 0u },
        { PL_OPERAND_CONST, 0u },
    };
    pl_operand locals[PL_VM_X86_ARCH_LOCAL_COUNT + 1u];
    for (pl_u32 index = 0u;
         index < PL_VM_X86_ARCH_LOCAL_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    locals[0] = (pl_operand){ PL_OPERAND_NODE, 1u };
    pl_plan plan = {
        .instructions = 1u, .span = 1u,
        .nodes = &node, .node_count = 1u,
        .arguments = arguments, .argument_count = 2u,
        .locals = locals,
        .local_count = PL_VM_X86_REGISTER_COUNT + 1u,
    };
    pl_wasm_block block = {
        .plan = &plan, .next_rip = 0x2000u,
        .result_kind = PL_VM_HALT,
    };
    pl_wasm_module_spec spec = { &block, 1u, NULL, 0u };
    pl_u32 measured = 0u, written = 0u;
    pl_u8 bytes[2048];
    CHECK("Wasm emitter measures integer plan",
          pl_wasm_module_measure(&spec, &measured), 0);
    CHECK("Wasm emitter writes measured plan",
          pl_wasm_module_write(&spec, bytes, sizeof bytes, &written), 0);
    CHECK("Wasm emitter measure equals write", written, measured);
    CHECK("Wasm emitter magic byte 0", bytes[0], 0u);
    CHECK("Wasm emitter magic byte 1", bytes[1], 'a');
    CHECK("Wasm emitter bounded write",
          pl_wasm_module_write(&spec, bytes, measured - 1u, &written),
          PL_ERROR_WASM_RANGE);

    pl_u8 encoded_body[1024], wrapped[2048];
    pl_u32 body_bytes = 0u, body_written = 0u;
    CHECK("Wasm emitter measures standalone function body",
          pl_wasm_block_measure(&block, 0u, &body_bytes), 0);
    CHECK("Wasm emitter writes standalone function body",
          pl_wasm_block_write(
              &block, 0u, encoded_body, sizeof encoded_body, &body_written),
          0);
    CHECK("standalone block measure equals write", body_written, body_bytes);
    pl_wasm_function_body raw_body = { encoded_body, body_written };
    pl_u32 wrapped_bytes = 0u, wrapped_written = 0u;
    CHECK("bounded body module measures",
          pl_wasm_body_module_measure(&raw_body, 1u, &wrapped_bytes), 0);
    CHECK("bounded body module writes",
          pl_wasm_body_module_write(
              &raw_body, 1u, wrapped, sizeof wrapped, &wrapped_written), 0);
    CHECK("bounded body module has canonical size", wrapped_written, written);
    CHECK("bounded body module equals retained-plan module",
          memcmp(wrapped, bytes, written), 0);

    block.machine_operation = PL_X86_MACHINE_DESCRIPTOR_TABLE;
    block.machine_argument = 4u;
    CHECK("Wasm emitter rejects a non-canonical machine ABI descriptor",
          pl_wasm_module_measure(&spec, &measured), PL_ERROR_WASM_ABI);
    block.machine_argument = 0u;
    block.machine_operation = PL_X86_MACHINE_NONE;

    pl_wasm_page_dispatch dispatcher = {
        .virtual_page = 0x6000u, .generation = 3u, .page_rank = 7u,
    };
    pl_wasm_module_spec dispatcher_spec = { NULL, 0u, &dispatcher, 1u };
    CHECK("Wasm emitter measures page dispatcher",
          pl_wasm_page_dispatch_measure(&dispatcher, &body_bytes), 0);
    CHECK("Wasm emitter writes page dispatcher",
          pl_wasm_page_dispatch_write(
              &dispatcher, encoded_body, sizeof encoded_body, &body_written),
          0);
    raw_body = (pl_wasm_function_body){ encoded_body, body_written };
    CHECK("raw dispatcher module measures",
          pl_wasm_body_module_measure(&raw_body, 1u, &wrapped_bytes), 0);
    CHECK("retained dispatcher module measures",
          pl_wasm_module_measure(&dispatcher_spec, &measured), 0);
    CHECK("raw dispatcher module keeps canonical size", wrapped_bytes, measured);

    node.opcode = PL_OPCODE_X86_ALU;
    node.argument_count = 4u;
    arguments[0] = (pl_operand){
        PL_OPERAND_LOCAL, PL_VM_X86_REGISTER_COUNT,
    };
    arguments[1] = (pl_operand){ PL_OPERAND_LOCAL, 0u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 42u };
    arguments[3] = (pl_operand){ PL_OPERAND_CONST, 64u | (1u << 8u) };
    plan.argument_count = 4u;
    locals[0] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u) | 16u,
    };
    locals[PL_VM_X86_REGISTER_COUNT] =
        (pl_operand){ PL_OPERAND_NODE, 1u };
    CHECK("Wasm emitter lowers fused x86 ALU flags and value",
          pl_wasm_module_measure(&spec, &measured), 0);
    locals[0].value = (1u << 8u) | 5u;
    CHECK("Wasm emitter lowers a flag condition projection",
          pl_wasm_module_measure(&spec, &measured), 0);
    node.opcode = PL_OPCODE_X86_COMPARE;
    arguments[3].value = 64u | (3u << 8u);
    CHECK("Wasm emitter lowers fused x86 compare flags",
          pl_wasm_module_measure(&spec, &measured), 0);
    node.opcode = PL_OPCODE_X86_TEST;
    arguments[3].value = 64u;
    CHECK("Wasm emitter lowers fused x86 test flags",
          pl_wasm_module_measure(&spec, &measured), 0);
    node.opcode = PL_OPCODE_X86_SHIFT_FLAGS;
    node.argument_count = 5u;
    arguments[1] = (pl_operand){ PL_OPERAND_LOCAL, 0u };
    arguments[2] = (pl_operand){ PL_OPERAND_LOCAL, 0u };
    arguments[3] = (pl_operand){ PL_OPERAND_CONST, 1u };
    arguments[4] = (pl_operand){ PL_OPERAND_CONST, 64u | (4u << 8u) };
    plan.argument_count = 5u;
    CHECK("Wasm emitter lowers fused x86 shift flags",
          pl_wasm_module_measure(&spec, &measured), 0);
    locals[0] = (pl_operand){ PL_OPERAND_NODE, 1u };
    locals[PL_VM_X86_REGISTER_COUNT] = (pl_operand){
        PL_OPERAND_LOCAL, PL_VM_X86_REGISTER_COUNT,
    };
    node.opcode = PL_OPCODE_X86_CONDITION;
    node.argument_count = 2u;
    arguments[0] = (pl_operand){
        PL_OPERAND_LOCAL, PL_VM_X86_REGISTER_COUNT,
    };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 4u };
    plan.argument_count = 2u;
    CHECK("Wasm emitter lowers an explicit x86 condition",
          pl_wasm_module_measure(&spec, &measured), 0);

    node.opcode = PL_OPCODE_MEMORY_LOAD;
    node.argument_count = 3u;
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[2] = (pl_operand){
        PL_OPERAND_CONST, 8u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    plan.argument_count = 3u;
    CHECK("Wasm emitter lowers direct memory load",
          pl_wasm_module_measure(&spec, &measured), 0);
    arguments[2].value |= 0x80000000u;
    CHECK("Wasm emitter rejects unknown memory shape",
          pl_wasm_module_measure(&spec, &measured), PL_ERROR_WASM_ABI);
    arguments[2].value = 8u | PL_MEMORY_SHAPE_VIRTUAL64;
    node.opcode = 155u; /* memory.i64.store */
    node.argument_count = 4u;
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 42u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[3] = (pl_operand){
        PL_OPERAND_CONST, 8u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    plan.argument_count = 4u;
    CHECK("Wasm emitter lowers direct memory store",
          pl_wasm_module_measure(&spec, &measured), 0);
    node.opcode = PL_OPCODE_MEMORY_PRE_STORE;
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, 0x3008u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 8u };
    CHECK("Wasm emitter lowers direct pre-store",
          pl_wasm_module_measure(&spec, &measured), 0);
    node.opcode = PL_OPCODE_MEMORY_REPEAT;
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, 0x3000u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 0x5a5au };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 32u };
    CHECK("Wasm emitter lowers restartable physical repeat",
          pl_wasm_module_measure(&spec, &measured), 0);
    node.opcode = PL_OPCODE_MEMORY_LOAD_REGION;
    node.argument_count = 4u;
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, 0x3000u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 2u };
    arguments[3] = (pl_operand){
        PL_OPERAND_CONST, 8u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    plan.argument_count = 4u;
    locals[0] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u) | 1u,
    };
    CHECK("Wasm emitter lowers one physical memory region",
          pl_wasm_module_measure(&spec, &measured), 0);
    arguments[2].value = 9u;
    CHECK("Wasm emitter bounds direct region publications",
          pl_wasm_module_measure(&spec, &measured), PL_ERROR_WASM_ABI);
    locals[0] = (pl_operand){ PL_OPERAND_NODE, 1u };
    node.opcode = 56u; /* lane32.div_s */
    node.argument_count = 2u;
    plan.argument_count = 2u;
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 42u };
    CHECK("Wasm emitter guards a one-instruction divide fault",
          pl_wasm_module_measure(&spec, &measured), 0);
    plan.instructions = 2u;
    CHECK("Wasm emitter requires a divide instruction fault cut",
          pl_wasm_module_measure(&spec, &measured),
          PL_ERROR_WASM_UNSUPPORTED);
    plan.instructions = 1u;
    node.opcode = PL_OPCODE_X86_DIVIDE;
    node.argument_count = 4u;
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 85u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 4u };
    arguments[3] = (pl_operand){ PL_OPERAND_CONST, 64u };
    plan.argument_count = 4u;
    locals[0] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u),
    };
    locals[2] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u) | 1u,
    };
    block.fault_predicate = (pl_operand){ PL_OPERAND_NODE, 1u };
    block.has_fault_predicate = 1u;
    block.fault_vector = 0u;
    CHECK("Wasm emitter lowers atomic x86 divide projections",
          pl_wasm_module_measure(&spec, &measured), 0);
    block.has_fault_predicate = 0u;
    CHECK("Wasm emitter rejects x86 divide without its #DE cut",
          pl_wasm_module_measure(&spec, &measured), PL_ERROR_WASM_ABI);
    block.fault_predicate = (pl_operand){ 0u, 0u };
    block.fault_vector = 0u;
    locals[2] = (pl_operand){ PL_OPERAND_LOCAL, 2u };
    locals[0] = (pl_operand){ PL_OPERAND_NODE, 1u };
    node.opcode = PL_OPCODE_ADD;
    block.result_kind = PL_VM_BARRIER;
    CHECK("Wasm emitter rejects unlowered terminal state",
          pl_wasm_module_measure(&spec, &measured), PL_ERROR_WASM_ABI);
    block.result_kind = PL_VM_HALT;
    node.opcode = PL_OPCODE_ADD;
    node.argument_count = 2u;
    arguments[0] = (pl_operand){ PL_OPERAND_LOCAL, 0u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 1u };
    plan.argument_count = 2u;
    plan.instructions = 0u;
    plan.local_count = PL_VM_X86_ARCH_LOCAL_COUNT + 1u;
    locals[PL_VM_X86_ARCH_LOCAL_COUNT] =
        (pl_operand){ PL_OPERAND_CONST, 3u };
    block.recurrence_local = PL_VM_X86_ARCH_LOCAL_COUNT;
    block.recurrence_bits = 64u;
    block.recurrence_source_instructions = 5u;
    CHECK("Wasm emitter closes recurrence retirement without dispatch",
          pl_wasm_module_measure(&spec, &measured), 0);
    block.recurrence_bits = 8u;
    CHECK("Wasm emitter rejects a non-x86 recurrence width",
          pl_wasm_module_measure(&spec, &measured), PL_ERROR_WASM_ABI);
}

static void check_affine_cut(void)
{
    pl_node nodes[3] = {
        { PL_OPCODE_ADD, 0u, 2u },
        { 74u, 2u, 2u },             /* lane64.IMUL */
        { 155u, 4u, 4u },            /* memory.i64.store */
    };
    pl_operand arguments[8] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 1u },
        { PL_OPERAND_LOCAL, 1u }, { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_LOCAL, 2u },
        { PL_OPERAND_CONST, 0u },
        { PL_OPERAND_CONST, 8u | PL_MEMORY_SHAPE_VIRTUAL64 },
    };
    pl_operand locals[3] = {
        { PL_OPERAND_NODE, 1u },
        { PL_OPERAND_NODE, 2u },
        { PL_OPERAND_LOCAL, 2u },
    };
    pl_plan plan = {
        .nodes = nodes, .node_count = 3u,
        .arguments = arguments, .argument_count = 8u,
        .locals = locals, .local_count = 3u,
    };
    pl_u8 storage[8192];
    pl_arena arena = { storage, sizeof storage, 0u };
    pl_affine report;
    CHECK("full-state affinity sees an opaque dead local",
          pl_affine_analyse(&plan, &arena, &report), 0);
    CHECK("full-state affinity rejects that local",
          report.verdict, PL_AFFINE_OPAQUE_SLOT);

    arena.used = 0u;
    CHECK("persistent cut analysis succeeds",
          pl_affine_analyse_cut(&plan, 0u, &arena, &report), 0);
    CHECK("persistent cut excludes dead opaque state",
          report.verdict, PL_AFFINE_OK);
    CHECK("persistent cut carries two inputs", report.cut_slot_count, 2u);
    CHECK("persistent cut executes two nodes", report.cut_node_count, 2u);
    CHECK("persistent cut finds the induction", report.induction, 0u);
    CHECK("persistent cut finds its step", report.step, 1);

    pl_node fused = { PL_OPCODE_X86_ALU, 0u, 4u };
    pl_operand fused_arguments[4] = {
        { PL_OPERAND_LOCAL, 1u }, { PL_OPERAND_LOCAL, 0u },
        { PL_OPERAND_CONST, 8u },
        { PL_OPERAND_CONST, 64u | (1u << 8u) },
    };
    pl_operand fused_locals[2] = {
        { PL_OPERAND_PROJECTION, (1u << 8u) | 16u },
        { PL_OPERAND_NODE, 1u },
    };
    pl_plan fused_plan = {
        .nodes = &fused, .node_count = 1u,
        .arguments = fused_arguments, .argument_count = 4u,
        .locals = fused_locals, .local_count = 2u,
    };
    arena.used = 0u;
    CHECK("fused ALU result remains in the affine grammar",
          pl_affine_analyse_cut(&fused_plan, 1u, &arena, &report), 0);
    CHECK("fused ALU carries a closed coordinate",
          report.verdict, PL_AFFINE_OK);
    CHECK("fused ALU projection keeps its step", report.step, 8);
}

static void check_local_physical_fold(void)
{
    pl_u8 first_storage[8192], second_storage[8192];
    pl_arena first_arena = { first_storage, sizeof first_storage, 0u };
    pl_arena second_arena = { second_storage, sizeof second_storage, 0u };
    pl_plan folded, compacted;

    pl_node add_nodes[2] = {
        { PL_OPCODE_ADD, 0u, 2u },
        { PL_OPCODE_ADD, 2u, 2u },
    };
    pl_operand add_arguments[4] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 5u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_CONST, 7u },
    };
    pl_operand add_locals[1] = { { PL_OPERAND_NODE, 2u } };
    pl_plan add_plan = {
        .nodes = add_nodes, .node_count = 2u,
        .arguments = add_arguments, .argument_count = 4u,
        .locals = add_locals, .local_count = 1u,
    };
    CHECK("physical fold closes consecutive affine constants",
          pl_fold_local_physical(&add_plan, &first_arena, &folded), 0);
    CHECK("physical fold compacts the superseded add",
          pl_compact_once(&folded, &second_arena, &compacted), 0);
    CHECK("two adds become one physical lane", compacted.node_count, 1u);
    CHECK("closed add retains the source coordinate",
          compacted.arguments[0].kind, PL_OPERAND_LOCAL);
    CHECK("closed add substitutes the combined constant",
          compacted.arguments[1].value, 12u);

    first_arena.used = 0u;
    second_arena.used = 0u;
    pl_node load_nodes[2] = {
        { PL_OPCODE_ADD, 0u, 2u },
        { PL_OPCODE_MEMORY_LOAD, 2u, 3u },
    };
    pl_operand load_arguments[5] = {
        { PL_OPERAND_LOCAL, 7u }, { PL_OPERAND_CONST, 8u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_CONST, 4u },
        { PL_OPERAND_CONST, 8u | PL_MEMORY_SHAPE_VIRTUAL64 },
    };
    pl_operand load_locals[1] = { { PL_OPERAND_NODE, 2u } };
    pl_plan load_plan = {
        .nodes = load_nodes, .node_count = 2u,
        .arguments = load_arguments, .argument_count = 5u,
        .locals = load_locals, .local_count = 1u,
    };
    CHECK("physical fold moves address constants into the access",
          pl_fold_local_physical(&load_plan, &first_arena, &folded), 0);
    CHECK("address fold compacts",
          pl_compact_once(&folded, &second_arena, &compacted), 0);
    CHECK("address add disappears", compacted.node_count, 1u);
    CHECK("load addresses the original base",
          compacted.arguments[0].value, 7u);
    CHECK("load carries the closed offset",
          compacted.arguments[1].value, 12u);

    first_arena.used = 0u;
    second_arena.used = 0u;
    pl_node store_nodes[2] = {
        { PL_OPCODE_ALU_IMMEDIATE[1][0], 0u, 2u },
        { PL_OPCODE_MEMORY_STORE8, 2u, 4u },
    };
    pl_operand store_arguments[6] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 0xffu },
        { PL_OPERAND_LOCAL, 7u }, { PL_OPERAND_NODE, 1u },
        { PL_OPERAND_CONST, 0u },
        { PL_OPERAND_CONST, 1u | PL_MEMORY_SHAPE_VIRTUAL64 },
    };
    pl_plan store_plan = {
        .nodes = store_nodes, .node_count = 2u,
        .arguments = store_arguments, .argument_count = 6u,
    };
    CHECK("physical fold removes a store-width mask",
          pl_fold_local_physical(&store_plan, &first_arena, &folded), 0);
    CHECK("store fold compacts",
          pl_compact_once(&folded, &second_arena, &compacted), 0);
    CHECK("masked byte store is one physical lane",
          compacted.node_count, 1u);
    CHECK("byte store takes the unmaterialized value",
          compacted.arguments[1].kind, PL_OPERAND_LOCAL);
    CHECK("byte store preserves the value coordinate",
          compacted.arguments[1].value, 0u);
}

static void check_fault_cut_composition(void)
{
    pl_node first_node = { PL_OPCODE_ADD, 0u, 2u };
    pl_operand first_arguments[2] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 1u },
    };
    pl_operand first_locals[2] = {
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_LOCAL, 1u },
    };
    pl_plan first = {
        .instructions = 1u, .nodes = &first_node, .node_count = 1u,
        .arguments = first_arguments, .argument_count = 2u,
        .locals = first_locals, .local_count = 2u,
    };
    pl_node divide_node = { 127u, 0u, 2u }; /* lane64.div_u */
    pl_operand divide_arguments[2] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_LOCAL, 1u },
    };
    pl_operand divide_locals[2] = {
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_LOCAL, 1u },
    };
    pl_plan divide = {
        .instructions = 1u, .nodes = &divide_node, .node_count = 1u,
        .arguments = divide_arguments, .argument_count = 2u,
        .locals = divide_locals, .local_count = 2u,
    };
    pl_u8 storage[4096];
    pl_arena arena = { storage, sizeof storage, 0u };
    pl_plan joined;
    CHECK("composition preserves a trapping instruction cut",
          pl_compose_raw(&first, &divide, &arena, &joined), PL_ERROR_PLAN);

    divide.instructions = 0u;
    arena.used = 0u;
    CHECK("same-instruction normalization may contain the trap",
          pl_compose_raw(&first, &divide, &arena, &joined), 0);
}

static void check_delivery_pack(void)
{
    pl_u8 payload[3] = { 7u, 11u, 19u };
    pl_delivery_locator locator = { { 0u }, 5u, sizeof payload };
    pl_sha256_digest(payload, sizeof payload, locator.digest);
    pl_u8 bytes[PL_DELIVERY_HEADER_BYTES + PL_DELIVERY_ROW_BYTES];
    pl_u32 written = 0u;
    CHECK("delivery locator writes",
          pl_delivery_index_write(
              &locator, 1u, 8u, bytes, sizeof bytes, &written), 0);
    CHECK("delivery locator has canonical extent", written, sizeof bytes);
    pl_delivery_index index;
    CHECK("delivery locator opens",
          pl_delivery_index_open(bytes, written, 8u, &index), 0);
    pl_delivery_locator selected;
    CHECK("delivery finds complete digest",
          pl_delivery_index_find(&index, locator.digest, &selected), 0);
    CHECK("delivery retains offset", selected.offset, 5u);
    CHECK("delivery authenticates selected payload",
          pl_delivery_payload_validate(
              &selected, payload, sizeof payload), 0);
    payload[0] ^= 1u;
    CHECK("delivery rejects changed payload",
          pl_delivery_payload_validate(
              &selected, payload, sizeof payload), PL_ERROR_DELIVERY);
    bytes[PL_DELIVERY_HEADER_BYTES + 44u] = 1u;
    CHECK("delivery rejects reserved row spelling",
          pl_delivery_index_open(bytes, written, 8u, &index),
          PL_ERROR_DELIVERY);
}

static pl_u32 make_physical_fixture(pl_u8 *target, pl_u32 capacity)
{
    enum { PAGE_BYTES = 16, MEMORY_BYTES = 4096 };
    pl_u8 page[PAGE_BYTES];
    pl_u8 memory[MEMORY_BYTES] = { 0u };
    for (pl_u32 index = 0u; index < PAGE_BYTES; ++index)
        page[index] = (pl_u8)(index * 7u + 3u);
    memcpy(memory, page, PAGE_BYTES);
    memcpy(memory + PAGE_BYTES * 2u, page, PAGE_BYTES);
    pl_u8 object_digest[PL_SHA256_BYTES];
    pl_sha256_digest(memory, sizeof memory, object_digest);
    pl_sha256 leaf;
    pl_u8 leaf_digest[PL_SHA256_BYTES];
    const pl_u8 zero = 0u;
    pl_sha256_open(&leaf);
    pl_sha256_write(&leaf, &zero, 1u);
    pl_sha256_write(&leaf, page, sizeof page);
    pl_sha256_close(&leaf, leaf_digest);

    const pl_u32 manifest_bytes = PL_PHYSICAL_MANIFEST_HEADER_BYTES + 4u;
    const pl_u32 prefix = PL_PHYSICAL_BUNDLE_HEADER_BYTES + manifest_bytes
                        + PL_PHYSICAL_BUNDLE_RECORD_BYTES;
    const pl_u32 total = prefix + 1u + PAGE_BYTES;
    if (!target || capacity < total) return 0u;
    memset(target, 0, total);
    memcpy(target, PL_PHYSICAL_BUNDLE_MAGIC, 4u);
    pl_write_u16(target + 4u, PL_PHYSICAL_BUNDLE_VERSION);
    pl_write_u16(target + 6u, PL_PHYSICAL_BUNDLE_HEADER_BYTES);
    pl_write_u32(target + 8u, manifest_bytes);
    pl_write_u32(target + 12u, 1u);
    pl_u8 *manifest = target + PL_PHYSICAL_BUNDLE_HEADER_BYTES;
    memcpy(manifest, PL_PHYSICAL_MANIFEST_MAGIC, 4u);
    pl_write_u16(manifest + 4u, PL_PHYSICAL_MANIFEST_VERSION);
    pl_write_u16(manifest + 6u, PL_PHYSICAL_MANIFEST_HEADER_BYTES);
    memcpy(manifest + 8u, object_digest, PL_SHA256_BYTES);
    pl_write_u64(manifest + 40u, 0u);
    pl_write_u64(manifest + 48u, MEMORY_BYTES);
    pl_write_u32(manifest + 56u, PAGE_BYTES);
    pl_write_u32(manifest + 60u, 1u);
    pl_write_u16(manifest + 64u, 1u);
    pl_write_u16(manifest + 66u, 1u);
    memcpy(manifest + 68u, leaf_digest, PL_SHA256_BYTES);
    pl_write_u32(manifest + 100u, 2u);
    manifest[104u] = 0u; /* page 0, unique rank 1 */
    manifest[105u] = 1u;
    manifest[106u] = 1u; /* skip page 1 */
    manifest[107u] = 1u;
    pl_u8 *record = manifest + manifest_bytes;
    pl_write_u32(record, 0u);
    pl_write_u16(record + 4u, 0u);
    pl_write_u32(record + 6u, 0u);
    pl_write_u32(record + 10u, PAGE_BYTES + 1u);
    memcpy(record + 14u, leaf_digest, PL_SHA256_BYTES);
    target[prefix] = 0u;
    memcpy(target + prefix + 1u, page, PAGE_BYTES);
    return total;
}

static void check_physical_bundle(void)
{
    pl_u8 bytes[512];
    pl_u32 length = make_physical_fixture(bytes, sizeof bytes);
    CHECK("physical fixture writes", length != 0u, 1);
    pl_physical_bundle bundle;
    CHECK("physical bundle opens",
          pl_physical_bundle_open(bytes, length, &bundle), 0);
    CHECK("physical bundle retains sparse length", bundle.length, 4096u);
    CHECK("physical bundle has one identity", bundle.unique_pages, 1u);
    pl_physical_cursor cursor;
    pl_physical_cursor_open(&bundle, &cursor);
    pl_u32 page = 0u, rank = 0u;
    CHECK("physical directory first row",
          pl_physical_cursor_next(&cursor, &page, &rank), 1);
    CHECK("physical directory first coordinate", page, 0u);
    CHECK("physical directory first rank", rank, 1u);
    CHECK("physical directory second row",
          pl_physical_cursor_next(&cursor, &page, &rank), 1);
    CHECK("physical directory preserves a hole", page, 2u);
    CHECK("physical directory shares identity", rank, 1u);
    CHECK("physical directory reaches one end",
          pl_physical_cursor_next(&cursor, &page, &rank), 0);
    pl_u8 decoded[16];
    CHECK("physical raw page authenticates",
          pl_physical_bundle_decode(
              &bundle, 1u, decoded, sizeof decoded, NULL, NULL), 0);
    CHECK("physical raw page retains bytes", decoded[7], 52u);
    bytes[length - 1u] ^= 1u;
    CHECK("physical leaf digest rejects changed bytes",
          pl_physical_bundle_decode(
              &bundle, 1u, decoded, sizeof decoded, NULL, NULL),
          PL_ERROR_PHYSICAL_DIGEST);
}

static void check_deflate(void)
{
    static const pl_u8 fixed[] = {
        0x78u, 0x01u, 0xcbu, 0x48u, 0xcdu, 0xc9u, 0xc9u, 0x57u,
        0xc8u, 0x40u, 0x27u, 0x15u, 0x01u, 0x70u, 0xd5u, 0x08u,
        0xd2u,
    };
    static const pl_u8 expected[] = "hello hello hello hello!";
    pl_u8 output[sizeof expected - 1u];
    CHECK("fixed Deflate decodes",
          pl_deflate_zlib(
              NULL, fixed, sizeof fixed, output, sizeof output), 0);
    CHECK("fixed Deflate preserves bytes",
          memcmp(output, expected, sizeof output), 0);
    pl_u8 changed[sizeof fixed];
    memcpy(changed, fixed, sizeof fixed);
    changed[sizeof changed - 1u] ^= 1u;
    CHECK("Deflate Adler checksum rejects a changed result",
          pl_deflate_zlib(
              NULL, changed, sizeof changed, output, sizeof output),
          PL_ERROR_DEFLATE);
}

static void check_boot_cache(void)
{
    static const char state_json[] =
        "{\"base_bytes\":0,\"baseline\":false,\"cr0\":1,\"cr2\":2,"
        "\"cr3\":3,\"cr4\":4,\"cr8\":8,"
        "\"debug\":[22,23,24,25,26,27,28,29],\"efer\":9,"
        "\"gdtr\":[10,11],\"halted\":false,\"idtr\":[12,13],"
        "\"interrupts\":[],\"ldtr\":20,\"memory_length\":4096,"
        "\"msrs\":[[30,31]],\"page_bytes\":256,"
        "\"page_encoding\":\"canonical-region-v1\",\"pages\":0,"
        "\"registers\":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"
        "\"rflags\":2,\"rip\":4096,"
        "\"segments\":[14,15,16,17,18,19],\"tr\":21,"
        "\"xmm\":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,"
        "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}";
    pl_u8 memory[512];
    pl_u32 memory_bytes = make_physical_fixture(memory, sizeof memory);
    pl_u8 cpu[2048];
    pl_u32 state_magic = (pl_u32)strlen(PL_X86_STATE_MAGIC);
    pl_u32 state_bytes = (pl_u32)strlen(state_json);
    memcpy(cpu, PL_X86_STATE_MAGIC, state_magic);
    pl_write_u32(cpu + state_magic, state_bytes);
    memcpy(cpu + state_magic + 4u, state_json, state_bytes);
    pl_u32 cpu_bytes = state_magic + 4u + state_bytes;
    char header[128];
    int measured = snprintf(
        header, sizeof header, "{\"cpu_bytes\":%u,\"memory_bytes\":%u}",
        cpu_bytes, memory_bytes);
    CHECK("boot header fits", measured > 0, 1);
    pl_u32 header_bytes = measured > 0 ? (pl_u32)measured : 0u;
    pl_u32 boot_magic = (pl_u32)strlen(PL_BOOT_CACHE_MAGIC);
    pl_u8 payload[4096];
    pl_u32 total = boot_magic + 4u + header_bytes
                 + cpu_bytes + memory_bytes;
    CHECK("boot fixture fits", total <= sizeof payload, 1);
    memcpy(payload, PL_BOOT_CACHE_MAGIC, boot_magic);
    pl_write_u32(payload + boot_magic, header_bytes);
    memcpy(payload + boot_magic + 4u, header, header_bytes);
    memcpy(payload + boot_magic + 4u + header_bytes, cpu, cpu_bytes);
    memcpy(payload + boot_magic + 4u + header_bytes + cpu_bytes,
           memory, memory_bytes);
    pl_boot_cache boot;
    CHECK("boot cache opens", pl_boot_cache_open(payload, total, &boot), 0);
    CHECK("boot embeds entry RIP", boot.state.rip, 4096u);
    CHECK("boot maps CR2 into the system bank", boot.state.system[0], 2u);
    CHECK("boot maps ES by architectural name", boot.state.system[6], 16u);
    CHECK("boot maps CS by architectural name", boot.state.system[7], 14u);
    CHECK("boot maps debug state", boot.state.system[21], 29u);
    CHECK("boot retains one MSR", boot.state.msr_count, 1u);
    CHECK("boot sets architectural MXCSR reset", boot.state.mxcsr, 0x1f80u);
    CHECK("boot sets architectural x87 tag reset", boot.state.x87_tag,
          0xffffu);
    CHECK("boot joins the sparse memory extent", boot.memory.length, 4096u);
}

int main(int argc, char **argv)
{
    int emit_vectors = argc > 1 && !strcmp(argv[1], "--vectors");
    check_continuation_roundtrip(emit_vectors);
    check_continuation_canonicality();
    check_continuation_projection();
    check_block_records();
    check_chained_roundtrip();
    check_elf_input();
    check_x86_frontend();
    check_x86_semantics();
    check_direct_executable();
    check_entry_map();
    check_residual_graph();
    check_instantiation_pages();
    check_authenticated_index();
    check_delivery_pack();
    check_deflate();
    check_physical_bundle();
    check_boot_cache();
    check_local_physical_fold();
    check_affine_cut();
    check_fault_cut_composition();
    check_wasm_emitter();
    if (failures) {
        fprintf(stderr, "%d assertion(s) failed\n", failures);
        return 1;
    }
    if (!emit_vectors) fprintf(stderr, "postlink selftest: ok\n");
    return 0;
}

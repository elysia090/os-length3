#include "internal/entry.h"
#include "internal/metadata.h"
#include "internal/table.h"

#define R_X86_64_64    1u
#define R_X86_64_PC32  2u
#define R_X86_64_PLT32 4u
#define R_X86_64_32   10u
#define R_X86_64_32S  11u
#define R_X86_64_16   12u
#define R_X86_64_8    14u
typedef struct {
    pl_u64 *values;
    pl_u8 *roles;
    pl_u32 capacity;
    pl_u32 count;
    int write;
} entry_sink;

typedef struct {
    pl_x86_code_grid *values;
    pl_u32 capacity;
    pl_u32 count;
    int write;
} code_grid_sink;

static int executable_symbol(const pl_elf_image *image,
                             const pl_elf_symbol *symbol,
                             pl_elf_section *section)
{
    if (!symbol->section_index
            || symbol->section_index >= image->section_count)
        return 0;
    if (pl_elf_section_read(image, symbol->section_index, section))
        return -1;
    return pl_elf_section_is_executable(section)
        && symbol->value >= section->address
        && symbol->value < section->address + section->memory_bytes;
}

static pl_u64 add_modular(pl_u64 base, pl_u64 addend_bits,
                          pl_u64 correction)
{
    /* ELF relocation arithmetic is performed in the relocation field's
     * modular integer domain.  Signed r_addend controls interpretation and
     * range checks at the final field, not whether S + A may wrap in u64. */
    return base + addend_bits + correction;
}

static int same_gpr(pl_x86_register left, pl_x86_register right)
{
    return left.class_id == PL_X86_REGISTER_GPR
        && right.class_id == PL_X86_REGISTER_GPR
        && left.index == right.index;
}

/* LEA addresses both code and immutable data embedded in PF_X.  A section
 * symbol plus addend becomes an execution root only when the resulting value
 * survives the local pure slice and is consumed by indirect control. */
static int local_indirect_control_address(
    const pl_x86_image *image, pl_u64 relocation_field)
{
    pl_x86_instruction address;
    if (!image
            || !pl_x86_relocation_instruction(
                image, relocation_field,
                PL_X86_RELOCATION_DISPLACEMENT, &address)
            || address.operation != PL_X86_OPERATION_LOAD_ADDRESS
            || address.visible_operand_count < 1u
            || address.operands[0].kind != PL_X86_OPERAND_REGISTER
            || address.operands[0].value.reg.class_id
               != PL_X86_REGISTER_GPR)
        return 0;
    pl_x86_register value = address.operands[0].value.reg;
    pl_x86_frontend frontend;
    if (pl_x86_frontend_open(image, &frontend)) return 0;
    pl_u64 at = address.fallthrough;
    enum { MAX_SLICE_INSTRUCTIONS = 32u };
    for (pl_u32 count = 0u; count < MAX_SLICE_INSTRUCTIONS; ++count) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(&frontend, at, &instruction)
                || instruction.fallthrough <= at)
            return 0;
        if ((instruction.flow == PL_X86_FLOW_JUMP
                    || instruction.flow == PL_X86_FLOW_CALL)
                && (instruction.flags & PL_X86_INSTRUCTION_INDIRECT)) {
            for (pl_u32 operand = 0u;
                    operand < instruction.visible_operand_count; ++operand)
                if (instruction.operands[operand].kind
                        == PL_X86_OPERAND_REGISTER
                        && same_gpr(
                            instruction.operands[operand].value.reg, value))
                    return 1;
            return 0;
        }
        for (pl_u32 operand = 0u;
                operand < instruction.operand_count; ++operand)
            if (instruction.operands[operand].kind
                    == PL_X86_OPERAND_REGISTER
                    && (instruction.operands[operand].flags
                        & (PL_X86_OPERAND_WRITE
                           | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    && same_gpr(
                        instruction.operands[operand].value.reg, value))
                return 0;
        if (instruction.flow != PL_X86_FLOW_NEXT) return 0;
        at = instruction.fallthrough;
    }
    return 0;
}

static int emit(entry_sink *sink, pl_u64 value, pl_u8 role)
{
    if (!(role & PL_X86_ENTRY_EXECUTION_ROOT)) return PL_ERROR_ELF;
    if (sink->count == 0xffffffffu) return PL_ERROR_ELF_RANGE;
    if (sink->write) {
        if (sink->count >= sink->capacity || !sink->roles)
            return PL_ERROR_ELF_RANGE;
        sink->values[sink->count] = value;
        sink->roles[sink->count] = role;
    }
    ++sink->count;
    return 0;
}

static int grid_cell(const pl_x86_frontend *frontend,
                     pl_u64 start, pl_u64 limit, pl_u64 *end,
                     pl_x86_instruction *terminal)
{
    pl_u64 rip = start;
    while (rip < limit) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status || instruction.fallthrough <= rip
                || instruction.fallthrough > limit)
            return 0;
        rip = instruction.fallthrough;
        if (instruction.flow == PL_X86_FLOW_NEXT) continue;
        /* A fixed cell may be shorter than its public stride only when
         * control cannot fall into the padding.  Conditional branches and
         * calls retain a fallthrough/return coordinate and therefore need a
         * different, consumer-proved representation. */
        if (instruction.flow == PL_X86_FLOW_CONDITIONAL
                || instruction.flow == PL_X86_FLOW_CALL)
            return 0;
        *end = rip;
        if (terminal) *terminal = instruction;
        return 1;
    }
    return 0;
}

static int recognize_grid_stride(
    const pl_x86_frontend *frontend, const pl_elf_symbol *symbol,
    pl_u64 stride, pl_x86_code_grid *out)
{
    if (!frontend || !symbol || !out || !stride
            || symbol->bytes % stride)
        return 0;
    pl_u64 count = symbol->bytes / stride;
    if (stride > 0xffffffffu || count > 0xffffffffu) return 0;
    for (pl_u64 cell = 0u; cell < count; ++cell) {
        pl_u64 start = symbol->value + cell * stride;
        pl_u64 cell_end = 0u;
        if (!grid_cell(frontend, start, start + stride, &cell_end, 0))
            return 0;
    }
    *out = (pl_x86_code_grid){
        symbol->value, symbol->bytes, (pl_u32)stride, (pl_u32)count, 0u
    };
    return 1;
}

static int recognize_code_grid(const pl_x86_image *image,
                               const pl_elf_symbol *symbol,
                               pl_x86_code_grid *out)
{
    if (!image || !symbol || !out || symbol->bytes < 2u
            || symbol->type == PL_ELF_SYMBOL_SECTION
            || symbol->bytes > 0xffffffffu
            || symbol->value > 0xffffffffffffffffull - symbol->bytes)
        return 0;
    pl_x86_frontend frontend;
    if (pl_x86_frontend_open(image, &frontend)) return 0;
    pl_u64 end = symbol->value + symbol->bytes;
    pl_u64 first_end = 0u;
    pl_x86_instruction terminal;
    if (!grid_cell(
            &frontend, symbol->value, end, &first_end, &terminal)
            || first_end <= symbol->value)
        return 0;
    /* A materialized function address plus an explicit extent after terminal
     * control publishes a finite code-associated byte span.  Those tail
     * bytes cannot affect ordinary execution; retaining them has meaning only
     * for a consumer that inspects or patches the source spelling. */
    if (symbol->type == PL_ELF_SYMBOL_FUNCTION) {
        int leaves_extent = terminal.flow == PL_X86_FLOW_RETURN
            || terminal.flow == PL_X86_FLOW_FAULT;
        /* A five-byte terminal jump followed by one exact fault instruction
         * is a finite patchable trampoline spelling: normal execution leaves
         * at the jump, while byte validation observes the fault signature.
         * Requiring the suffix to decode as one complete fault avoids turning
         * ordinary jump-first multi-entry functions into identity regions. */
        if (!leaves_extent && terminal.flow == PL_X86_FLOW_JUMP
                && first_end < end) {
            pl_x86_instruction signature;
            if (!pl_x86_frontend_decode(
                    &frontend, first_end, &signature)
                    && signature.flow == PL_X86_FLOW_FAULT
                    && signature.fallthrough == end)
                leaves_extent = 1;
        }
        /* This representation is one terminal cell plus an observed tail,
         * not a blanket identity promise for an ordinary multi-block
         * function.  A later terminal can have independently admitted labels
         * and alternative paths inside the symbol extent. */
        if (terminal.rip != symbol->value
                || first_end >= end || !leaves_extent)
            return 0;
        *out = (pl_x86_code_grid){
            symbol->value, symbol->bytes, (pl_u32)symbol->bytes, 1u,
            PL_X86_CODE_GRID_SOURCE_IDENTITY
        };
        return 1;
    }
    pl_u64 minimum = first_end - symbol->value;
    pl_u64 maximum = symbol->bytes / 2u;
    /* A grid stride must divide the finite symbol extent.  Walking every
     * integer stride and then decoding all cells made recognition quadratic
     * on a large observed object.  Enumerate the exact divisor population in
     * ascending order: small divisors first, then paired large divisors in
     * reverse divisor order.  The first valid candidate is unchanged. */
    pl_u64 root = 1u;
    while (root + 1u <= symbol->bytes / (root + 1u)) ++root;
    for (pl_u64 divisor = 1u; divisor <= root; ++divisor) {
        if (symbol->bytes % divisor || divisor < minimum
                || divisor > maximum)
            continue;
        if (recognize_grid_stride(&frontend, symbol, divisor, out))
            return 1;
    }
    for (pl_u64 divisor = root; divisor; --divisor) {
        if (symbol->bytes % divisor) continue;
        pl_u64 stride = symbol->bytes / divisor;
        if (stride == divisor || stride < minimum || stride > maximum)
            continue;
        if (recognize_grid_stride(&frontend, symbol, stride, out))
            return 1;
    }
    return 0;
}

static int emit_grid(code_grid_sink *grids, entry_sink *entries,
                     const pl_x86_image *image,
                     const pl_elf_symbol *symbol, pl_u64 value,
                     pl_u8 role)
{
    int status = emit(entries, value, role);
    if (status || !(role & PL_X86_ENTRY_ADDRESS_VALUE)
            || value != symbol->value)
        return status;
    pl_x86_code_grid grid;
    if (!recognize_code_grid(image, symbol, &grid)) {
        /* A zero-sized local label can still be published through allocated
         * data and subsequently inspected or patched as bytes.  Until a
         * whole-program no-write/no-read proof discharges that observation,
         * its first exact instruction is the necessary identity extent.  The
         * decoder supplies the finite extent; no symbol-name or section-name
         * convention enters the artifact. */
        if (!(role & PL_X86_ENTRY_SOURCE_IDENTITY)) return 0;
        pl_x86_frontend frontend;
        pl_x86_instruction instruction;
        if (pl_x86_frontend_open(image, &frontend)
                || pl_x86_frontend_decode(&frontend, value, &instruction)
                || instruction.rip != value
                || instruction.fallthrough <= value
                || instruction.fallthrough - value > 0xffffffffu)
            return 0;
        pl_u32 bytes = (pl_u32)(instruction.fallthrough - value);
        grid = (pl_x86_code_grid){
            value, bytes, bytes, 1u,
            PL_X86_CODE_GRID_SOURCE_IDENTITY
        };
    }
    if (!grids || grids->count == 0xffffffffu) return PL_ERROR_ELF_RANGE;
    if (grids->write) {
        if (!grids->values || grids->count >= grids->capacity)
            return PL_ERROR_ELF_RANGE;
        grids->values[grids->count] = grid;
    }
    ++grids->count;
    /* The base was emitted above.  Every other cell is a distinct observable
     * execution coordinate even when its future body later shares a class. */
    for (pl_u32 cell = 1u; cell < grid.count; ++cell) {
        status = emit(
            entries, grid.start + (pl_u64)cell * grid.stride,
            PL_X86_ENTRY_EXECUTION_ROOT | PL_X86_ENTRY_ADDRESS_VALUE);
        if (status) return status;
    }
    return 0;
}

static int collect_published_functions(
    const pl_elf_image *image, entry_sink *sink)
{
    for (pl_u32 section_index = 0u;
            section_index < image->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, section_index, &section);
        if (status) return status;
        /* A static symbol name is construction history.  Direct control,
         * code-address values and allocated metadata are closed by the
         * relocation walk below.  Only the runtime dynamic symbol table can
         * independently publish a function coordinate. */
        if (section.type != PL_ELF_SECTION_DYNSYM) continue;
        if (section.entry_bytes != PL_ELF_SYMBOL_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 count = section.file_bytes / section.entry_bytes;
        if (count > 0xffffffffu) return PL_ERROR_ELF_RANGE;
        for (pl_u32 index = 0u; index < (pl_u32)count; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section target;
            status = pl_elf_symbol_read(
                image, section_index, index, &symbol);
            if (status) return status;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION) continue;
            int executable = executable_symbol(image, &symbol, &target);
            if (executable < 0) return PL_ERROR_ELF;
            if (!executable) continue;
            pl_u8 role = PL_X86_ENTRY_EXECUTION_ROOT
                       | PL_X86_ENTRY_ADDRESS_VALUE;
            status = emit(sink, symbol.value, role);
            if (status) return status;
        }
    }
    return 0;
}

static int function_symbol_capacity(const pl_elf_image *image,
                                    pl_u32 *out)
{
    pl_u32 count = 0u;
    int have_static_symbols = 0;
    if (!image || !out) return PL_ERROR_ELF;
    for (pl_u32 index = 0u; index < image->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, index, &section);
        if (status) return status;
        if (section.type == PL_ELF_SECTION_SYMTAB) {
            have_static_symbols = 1;
            break;
        }
    }
    for (pl_u32 section_index = 0u;
            section_index < image->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, section_index, &section);
        if (status) return status;
        if (section.type != (have_static_symbols
                ? PL_ELF_SECTION_SYMTAB : PL_ELF_SECTION_DYNSYM))
            continue;
        if (section.entry_bytes != PL_ELF_SYMBOL_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 symbols = section.file_bytes / section.entry_bytes;
        if (symbols > 0xffffffffu) return PL_ERROR_ELF_RANGE;
        for (pl_u32 index = 0u; index < (pl_u32)symbols; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section target;
            status = pl_elf_symbol_read(
                image, section_index, index, &symbol);
            if (status) return status;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION || symbol.bytes < 2u)
                continue;
            int executable = executable_symbol(image, &symbol, &target);
            if (executable < 0) return PL_ERROR_ELF;
            if (!executable) continue;
            if (count == 0xffffffffu) return PL_ERROR_ELF_RANGE;
            ++count;
        }
    }
    *out = count;
    return 0;
}

static int entry_has_role(const pl_u64 *entries, const pl_u8 *roles,
                          pl_u32 begin, pl_u32 end, pl_u64 value,
                          pl_u8 role)
{
    pl_u32 limit = end;
    while (begin < end) {
        pl_u32 middle = begin + (end - begin) / 2u;
        if (entries[middle] < value) begin = middle + 1u;
        else end = middle;
    }
    return roles && entries && begin < limit
        && entries[begin] == value && (roles[begin] & role) != 0u;
}

static int observed_entry(const pl_u64 *entries, const pl_u8 *roles,
                          pl_u32 primary_count, pl_u32 entry_count,
                          pl_u64 value)
{
    if (!entries || !roles || primary_count > entry_count) return 0;
    return entry_has_role(
               entries, roles, 0u, primary_count, value,
               PL_X86_ENTRY_ADDRESS_VALUE)
        || entry_has_role(
               entries, roles, primary_count, entry_count, value,
               PL_X86_ENTRY_ADDRESS_VALUE);
}

static int collect_observed_function_grids(
    const pl_elf_image *image, const pl_x86_image *executable_image,
    const pl_u64 *entries, const pl_u8 *roles,
    pl_u32 primary_count, pl_u32 entry_count, code_grid_sink *grids)
{
    int have_static_symbols = 0;
    if (!image || !executable_image || !entries || !roles || !grids)
        return PL_ERROR_ELF;
    for (pl_u32 index = 0u; index < image->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, index, &section);
        if (status) return status;
        if (section.type == PL_ELF_SECTION_SYMTAB) {
            have_static_symbols = 1;
            break;
        }
    }
    for (pl_u32 section_index = 0u;
            section_index < image->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, section_index, &section);
        if (status) return status;
        if (section.type != (have_static_symbols
                ? PL_ELF_SECTION_SYMTAB : PL_ELF_SECTION_DYNSYM))
            continue;
        if (section.entry_bytes != PL_ELF_SYMBOL_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 symbols = section.file_bytes / section.entry_bytes;
        if (symbols > 0xffffffffu) return PL_ERROR_ELF_RANGE;
        for (pl_u32 index = 0u; index < (pl_u32)symbols; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section target;
            status = pl_elf_symbol_read(
                image, section_index, index, &symbol);
            if (status) return status;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION || symbol.bytes < 2u
                    || !observed_entry(
                        entries, roles, primary_count, entry_count,
                        symbol.value))
                continue;
            int executable = executable_symbol(image, &symbol, &target);
            if (executable < 0) return PL_ERROR_ELF;
            if (!executable) continue;
            pl_x86_code_grid grid;
            if (!recognize_code_grid(executable_image, &symbol, &grid))
                continue;
            if (grids->count == 0xffffffffu) return PL_ERROR_ELF_RANGE;
            if (grids->write) {
                if (!grids->values || grids->count >= grids->capacity)
                    return PL_ERROR_ELF_RANGE;
                grids->values[grids->count] = grid;
            }
            ++grids->count;
        }
    }
    return 0;
}

static int section_named(const pl_elf_image *image,
                         const pl_elf_section *section,
                         const char *expected)
{
    if (!image || !section || !expected
            || image->section_name_index >= image->section_count)
        return 0;
    pl_elf_section names;
    if (pl_elf_section_read(
            image, image->section_name_index, &names)
            || names.type != PL_ELF_SECTION_STRTAB
            || section->name_offset >= names.file_bytes)
        return 0;
    const pl_u8 *name = image->bytes + names.file_offset
                      + section->name_offset;
    pl_u64 available = names.file_bytes - section->name_offset;
    pl_u64 index = 0u;
    while (expected[index]) {
        if (index >= available || name[index] != (pl_u8)expected[index])
            return 0;
        ++index;
    }
    return index < available && name[index] == 0u;
}

static int add_i32(pl_u64 base, pl_i32 delta, pl_u64 *out)
{
    if (!out) return 0;
    if (delta >= 0)
        return pl_checked_add_u64(base, (pl_u64)(pl_u32)delta, out);
    pl_u64 magnitude = (pl_u64)(0u - (pl_u32)delta);
    if (base < magnitude) return 0;
    *out = base - magnitude;
    return 1;
}

static int append_identity_grid(code_grid_sink *grids,
                                const pl_x86_image *image,
                                pl_u64 start, pl_u32 bytes)
{
    if (!bytes) return 0;
    pl_u64 last;
    if (!grids || !image
            || !pl_checked_add_u64(start, bytes - 1u, &last)
            || !pl_x86_image_contains(image, start)
            || !pl_x86_image_contains(image, last)
            || grids->count == 0xffffffffu)
        return PL_ERROR_ELF;
    if (grids->write) {
        if (!grids->values || grids->count >= grids->capacity)
            return PL_ERROR_ELF_RANGE;
        grids->values[grids->count] = (pl_x86_code_grid){
            start, bytes, bytes, 1u,
            PL_X86_CODE_GRID_SOURCE_IDENTITY
        };
    }
    ++grids->count;
    return 0;
}

/* Linux alternatives are runtime code-copy descriptors, not inert linker
 * history.  Both finite byte spans remain identity coordinates until Linux
 * selects one; their relative pointer fields are still rewritten by the
 * ordinary relocation pass. */
static int collect_alternative_grids(
    const pl_elf_image *image, const pl_x86_image *executable_image,
    entry_sink *boundaries, code_grid_sink *grids)
{
    if (!image || !executable_image || !boundaries || !grids)
        return PL_ERROR_ELF;
    for (pl_u32 index = 0u; index < image->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, index, &section);
        if (status) return status;
        if (!section_named(image, &section, ".altinstructions")) continue;
        if (section.type != PL_ELF_SECTION_PROGBITS
                || !(section.flags & PL_ELF_SECTION_ALLOC)
                || section.entry_bytes != 14u
                || section.file_bytes % 14u)
            return PL_ERROR_ELF;
        for (pl_u64 offset = 0u; offset < section.file_bytes;
                offset += 14u) {
            const pl_u8 *row = image->bytes + section.file_offset + offset;
            pl_u64 record = section.address + offset;
            pl_u64 original;
            pl_u64 replacement;
            if (!add_i32(record, (pl_i32)pl_read_u32(row), &original)
                    || !add_i32(
                        record + 4u,
                        (pl_i32)pl_read_u32(row + 4u), &replacement)
                    || !row[12])
                return PL_ERROR_ELF;
            status = emit(
                boundaries, original,
                PL_X86_ENTRY_EXECUTION_ROOT
                | PL_X86_ENTRY_ADDRESS_VALUE);
            if (!status)
                status = append_identity_grid(
                    grids, executable_image, original, row[12]);
            pl_u64 original_end;
            if (!status
                    && (!pl_checked_add_u64(
                            original, row[12], &original_end)
                        || (pl_x86_image_contains(
                                executable_image, original_end)
                            && emit(boundaries, original_end,
                                    PL_X86_ENTRY_EXECUTION_ROOT))))
                status = PL_ERROR_ELF;
            if (!status && row[13]) {
                status = emit(
                    boundaries, replacement,
                    PL_X86_ENTRY_EXECUTION_ROOT
                    | PL_X86_ENTRY_ADDRESS_VALUE);
                if (!status)
                    status = append_identity_grid(
                        grids, executable_image, replacement, row[13]);
                pl_u64 replacement_end;
                if (!status
                        && (!pl_checked_add_u64(
                                replacement, row[13], &replacement_end)
                            || (pl_x86_image_contains(
                                    executable_image, replacement_end)
                                && emit(boundaries, replacement_end,
                                        PL_X86_ENTRY_EXECUTION_ROOT))))
                    status = PL_ERROR_ELF;
            }
            if (status) return status;
        }
    }
    return 0;
}

/* A PC-relative word in allocated data becomes an executable coordinate only
 * together with a linked base.  Prove that missing half without admitting all
 * raw rel32 data: some decoded instruction in executable storage must
 * materialize an address inside the row's section.  The row's own relocation
 * then supplies the exact inverse, S + A, independently of section names.
 *
 * Every code relocation is inspected once and marks its target section.  The
 * previous target-at-a-time query rescanned the complete code relocation
 * population for every allocated data section, making entry closure
 * quadratic in an otherwise linear linked-ELF walk. */
static int mark_code_referenced_sections(
    const pl_elf_image *image, const pl_x86_image *executable_image,
    pl_u8 *support, pl_u64 support_bytes)
{
    if (!image || !executable_image || !support)
        return PL_ERROR_ELF;
    pl_u64 required = ((pl_u64)image->section_count + 7u) >> 3u;
    if (support_bytes < required) return PL_ERROR_ELF;
    for (pl_u64 byte = 0u; byte < required; ++byte) support[byte] = 0u;
    for (pl_u32 section_index = 0u;
            section_index < image->section_count; ++section_index) {
        pl_elf_section relocations;
        int status = pl_elf_section_read(
            image, section_index, &relocations);
        if (status) return status;
        if (relocations.type != PL_ELF_SECTION_RELA
                || !relocations.info)
            continue;
        pl_elf_section place;
        status = pl_elf_section_read(image, relocations.info, &place);
        if (status) return status;
        if (!pl_elf_section_is_executable(&place)) continue;
        if (relocations.entry_bytes != PL_ELF_RELOCATION_BYTES
                || relocations.file_bytes % relocations.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 count = relocations.file_bytes / relocations.entry_bytes;
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol;
            status = pl_elf_relocation_read(
                image, section_index, index, &relocation);
            if (status) return status;
            status = pl_elf_symbol_read(
                image, relocation.symbol_table_section,
                relocation.symbol_index, &symbol);
            if (status) return status;
            pl_x86_instruction instruction;
            if (symbol.section_index < image->section_count
                    && (pl_x86_relocation_instruction(
                    executable_image, relocation.offset,
                    PL_X86_RELOCATION_DISPLACEMENT, &instruction)
                    || pl_x86_relocation_instruction(
                        executable_image, relocation.offset,
                        PL_X86_RELOCATION_IMMEDIATE, &instruction)))
                support[symbol.section_index >> 3u] |=
                    (pl_u8)(1u << (symbol.section_index & 7u));
        }
    }
    return 0;
}

static int collect_relocation_targets(const pl_elf_image *image,
                                      const pl_x86_image *executable_image,
                                      const pl_x86_table *tables,
                                      pl_u32 table_count,
                                      int normalized,
                                      pl_u8 *analysis_workspace,
                                      pl_u64 analysis_workspace_bytes,
                                      entry_sink *sink,
                                      code_grid_sink *grids,
                                      pl_u32 *table_targets)
{
    if (normalized) {
        int status = mark_code_referenced_sections(
            image, executable_image, analysis_workspace,
            analysis_workspace_bytes);
        if (status) return status;
    }
    for (pl_u32 section_index = 0u;
            section_index < image->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(image, section_index, &section);
        if (status) return status;
        if (section.type != PL_ELF_SECTION_RELA) continue;
        if (section.entry_bytes != PL_ELF_RELOCATION_BYTES
                || section.file_bytes % section.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 count = section.file_bytes / section.entry_bytes;
        int code_place = 0;
        pl_elf_section place = { 0 };
        if (section.info) {
            status = pl_elf_section_read(image, section.info, &place);
            if (status) return status;
            /* Relocations whose target section is absent from PT_LOAD are
             * construction/debug records.  They cannot publish a runtime
             * entry or materialized code address. */
            if (!(place.flags & PL_ELF_SECTION_ALLOC)) continue;
            code_place = pl_elf_section_is_executable(&place);
        }
        pl_x86_table_cursor table = { 0 };
        int place_referenced_by_code = normalized && !code_place
            && !!(analysis_workspace[section.info >> 3u]
                  & (pl_u8)(1u << (section.info & 7u)));
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol;
            pl_elf_section target;
            status = pl_elf_relocation_read(
                image, section_index, index, &relocation);
            if (status) return status;
            status = pl_elf_symbol_read(
                image, relocation.symbol_table_section,
                relocation.symbol_index, &symbol);
            if (status) return status;
            int executable = executable_symbol(image, &symbol, &target);
            if (executable < 0) return PL_ERROR_ELF;
            if (!executable) continue;
            /* Measurement has no decoded consumer yet.  Count every
             * executable-target PC-relative datum in allocated data as a
             * possible table row so the later proof can never outgrow its
             * workspace.  The normalized pass admits only proved rows. */
            if (!normalized && !code_place
                    && relocation.type == R_X86_64_PC32) {
                status = emit_grid(
                    grids, sink, executable_image, &symbol, symbol.value,
                    PL_X86_ENTRY_EXECUTION_ROOT
                    | PL_X86_ENTRY_ADDRESS_VALUE);
                if (status) return status;
                continue;
            }
            if (normalized) {
                int recognized = 0;
                pl_u64 table_base = 0u;
                pl_u64 table_target = 0u;
                status = pl_x86_table_row(
                    image, &relocation, &symbol, &place,
                    tables, table_count, &table,
                    &recognized, &table_base, &table_target);
                if (status) return status;
                (void)table_base;
                if (recognized) {
                    status = emit_grid(
                        grids, sink, executable_image, &symbol, table_target,
                        PL_X86_ENTRY_EXECUTION_ROOT
                        | PL_X86_ENTRY_ADDRESS_VALUE);
                    if (status) return status;
                    if (table_targets) {
                        if (*table_targets == 0xffffffffu)
                            return PL_ERROR_ELF_RANGE;
                        ++*table_targets;
                    }
                    continue;
                }
                /* PC-relative data is not itself a pointer: the stored word
                 * is S+A-P and its consumer chooses the base that turns it
                 * into a coordinate.  Only a proved control projection above
                 * supplies that missing observation.  Treating raw S+A as a
                 * target invents execution roots from string/constant rows in
                 * PF_X and retains a second, scalar decoding path. */
                if (!code_place && !place_referenced_by_code
                        && (relocation.type == R_X86_64_PC32
                            || relocation.type == R_X86_64_PLT32))
                    continue;
            }
            /* A PC-relative code relocation normally names either direct
             * control (closed by decode) or a memory datum.  An absolute
             * relocation is different: reachable code materializes the
             * executable coordinate as a value, so it is an observable entry
             * regardless of whether assembly gave the target STT_FUNC or
             * STT_NOTYPE.  Linux hardware entries use the latter. */
            int absolute_code_address = code_place
                && (relocation.type == R_X86_64_64
                    || relocation.type == R_X86_64_32
                    || relocation.type == R_X86_64_32S
                    || relocation.type == R_X86_64_16
                    || relocation.type == R_X86_64_8);
            int local_control_address = code_place
                && (relocation.type == R_X86_64_PC32
                    || relocation.type == R_X86_64_PLT32)
                && local_indirect_control_address(
                    executable_image, relocation.offset);
            if (code_place && symbol.type != PL_ELF_SYMBOL_FUNCTION
                    && !absolute_code_address && !local_control_address)
                continue;
            if (!code_place
                    && symbol.type != PL_ELF_SYMBOL_FUNCTION
                    && symbol.type != PL_ELF_SYMBOL_SECTION
                    && symbol.bytes)
                continue;

            pl_u64 candidate = symbol.value;
            pl_u64 correction = code_place
                             && (relocation.type == R_X86_64_PC32
                                 || relocation.type == R_X86_64_PLT32)
                              ? 4u : 0u;
            if (relocation.type == R_X86_64_64
                    || relocation.type == R_X86_64_PC32
                    || relocation.type == R_X86_64_PLT32
                    || relocation.type == R_X86_64_32
                    || relocation.type == R_X86_64_32S
                    || relocation.type == R_X86_64_16
                    || relocation.type == R_X86_64_8) {
                candidate = add_modular(
                    symbol.value, relocation.addend_bits, correction);
            }
            if (candidate < target.address
                    || candidate >= target.address + target.memory_bytes)
                continue;
            pl_u8 role = PL_X86_ENTRY_EXECUTION_ROOT;
            pl_x86_instruction direct_instruction;
            int direct_control = code_place
                && (relocation.type == R_X86_64_PC32
                    || relocation.type == R_X86_64_PLT32)
                && executable_image
                && pl_x86_relocation_instruction(
                    executable_image, relocation.offset,
                    PL_X86_RELOCATION_DIRECT_CONTROL,
                    &direct_instruction);
            if (!direct_control) role |= PL_X86_ENTRY_ADDRESS_VALUE;
            if (!code_place && place_referenced_by_code
                    && (relocation.type == R_X86_64_PC32
                        || relocation.type == R_X86_64_PLT32))
                role |= PL_X86_ENTRY_SOURCE_IDENTITY;
            status = emit_grid(
                grids, sink, executable_image, &symbol, candidate, role);
            if (status) return status;
        }
    }
    return 0;
}

static int collect_metadata_pointer(
    void *context, const pl_x86_metadata_pointer *pointer)
{
    return emit(
        (entry_sink *)context, pointer->target_address,
        PL_X86_ENTRY_EXECUTION_ROOT | PL_X86_ENTRY_ADDRESS_VALUE);
}

static int collect_primary(const pl_elf_image *image, entry_sink *sink)
{
    if (!image || !sink || !image->section_count) return PL_ERROR_ELF;
    pl_u64 entry = 0u;
    int present = 0;
    int status = pl_elf_process_entry(image, &entry, &present);
    if (!status && present)
        status = emit(sink, entry, PL_X86_ENTRY_EXECUTION_ROOT);
    if (!status) status = collect_published_functions(image, sink);
    return status;
}

static int collect_metadata(const pl_elf_image *image,
                            const pl_x86_image *executable_image,
                            const pl_x86_table *tables,
                            pl_u32 table_count,
                            int normalized,
                            pl_u8 *analysis_workspace,
                            pl_u64 analysis_workspace_bytes,
                            entry_sink *sink,
                            code_grid_sink *grids,
                            pl_u32 *table_targets)
{
    if (!image || !sink || !image->section_count) return PL_ERROR_ELF;
    int status = collect_relocation_targets(
        image, executable_image, tables, table_count, normalized,
        analysis_workspace, analysis_workspace_bytes,
        sink, grids, table_targets);
    if (!status) {
        pl_x86_metadata_report report;
        status = pl_x86_metadata_walk(
            image, collect_metadata_pointer, sink, &report);
    }
    return status;
}

int pl_x86_entry_measure(const pl_elf_image *image,
                         const pl_x86_image *executable_image,
                         pl_x86_entry_population *out)
{
    if (!out) return PL_ERROR_ELF;
    entry_sink primary = { 0, 0, 0u, 0u, 0 };
    entry_sink metadata = { 0, 0, 0u, 0u, 0 };
    code_grid_sink grids = { 0, 0u, 0u, 0 };
    int status = collect_primary(image, &primary);
    if (!status)
        status = collect_metadata(
            image, executable_image, 0, 0u, 0, 0, 0u,
            &metadata, &grids, 0);
    if (!status)
        status = collect_alternative_grids(
            image, executable_image, &metadata, &grids);
    pl_u32 table_base_candidates = 0u;
    if (!status)
        status = pl_x86_table_base_measure(
            image, &table_base_candidates);
    pl_u32 function_grid_candidates = 0u;
    if (!status)
        status = function_symbol_capacity(image, &function_grid_candidates);
    if (status) return status;
    if (primary.count > 0xffffffffu - metadata.count)
        return PL_ERROR_ELF_RANGE;
    if (grids.count > 0xffffffffu - function_grid_candidates)
        return PL_ERROR_ELF_RANGE;
    pl_u32 code_grid_candidates = grids.count + function_grid_candidates;
    /* Native closure may discover that one address-valued metadata target is
     * an instruction field rather than an entry.  At most one finite
     * source-identity span is appended per metadata candidate; this is
     * compiler workspace, never an output-side per-byte map. */
    if (code_grid_candidates > 0xffffffffu - metadata.count)
        return PL_ERROR_ELF_RANGE;
    code_grid_candidates += metadata.count;
    out->candidate_count = primary.count + metadata.count;
    out->entry_count = 0u;
    out->primary_candidate_count = primary.count;
    out->primary_count = 0u;
    out->table_base_candidate_count = table_base_candidates;
    out->table_base_count = 0u;
    out->table_target_count = 0u;
    out->address_observable_count = 0u;
    out->code_grid_candidate_count = code_grid_candidates;
    out->code_grid_count = 0u;
    return primary.count ? 0 : PL_ERROR_ELF;
}

static void radix_sort(pl_u64 *values, pl_u64 *scratch,
                       pl_u8 *roles, pl_u8 *role_scratch, pl_u32 count)
{
    pl_u64 *source = values;
    pl_u64 *target = scratch;
    pl_u8 *source_roles = roles;
    pl_u8 *target_roles = role_scratch;
    for (pl_u32 pass = 0u; pass < 8u; ++pass) {
        pl_u32 counts[256] = { 0u };
        pl_u32 offsets[256];
        pl_u32 shift = pass * 8u;
        for (pl_u32 index = 0u; index < count; ++index)
            ++counts[(source[index] >> shift) & 0xffu];
        pl_u32 at = 0u;
        for (pl_u32 digit = 0u; digit < 256u; ++digit) {
            offsets[digit] = at;
            at += counts[digit];
        }
        for (pl_u32 index = 0u; index < count; ++index) {
            pl_u32 digit = (pl_u32)((source[index] >> shift) & 0xffu);
            pl_u32 destination = offsets[digit]++;
            target[destination] = source[index];
            target_roles[destination] = source_roles[index];
        }
        pl_u64 *swap = source;
        source = target;
        target = swap;
        pl_u8 *role_swap = source_roles;
        source_roles = target_roles;
        target_roles = role_swap;
    }
}

int pl_x86_entry_write(const pl_elf_image *image,
                       const pl_x86_image *executable_image,
                       pl_u64 *entries, pl_u32 entry_capacity,
                       pl_u64 *scratch, pl_u32 scratch_capacity,
                       pl_u8 *roles, pl_u8 *role_scratch,
                       pl_x86_code_grid *code_grids,
                       pl_u32 code_grid_capacity,
                       pl_x86_table *tables, pl_u32 table_capacity,
                       pl_x86_table *table_scratch,
                       pl_u32 table_scratch_capacity,
                       pl_u8 *analysis_workspace,
                       pl_u64 analysis_workspace_bytes,
                       pl_x86_entry_population *out)
{
    if (!entries || !scratch || !roles || !role_scratch
            || !code_grids || !tables || !table_scratch
            || !analysis_workspace || !analysis_workspace_bytes
            || !executable_image || !out)
        return PL_ERROR_ELF;
    entry_sink primary = { entries, roles, entry_capacity, 0u, 1 };
    int status = collect_primary(image, &primary);
    if (status) return status;
    if (!primary.count || primary.count > entry_capacity)
        return PL_ERROR_ELF_RANGE;
    radix_sort(entries, scratch, roles, role_scratch, primary.count);
    pl_u32 primary_unique = 0u;
    for (pl_u32 index = 0u; index < primary.count; ++index) {
        if (primary_unique
                && entries[index] == entries[primary_unique - 1u]) {
            roles[primary_unique - 1u] |= roles[index];
        } else {
            entries[primary_unique++] = entries[index];
            roles[primary_unique - 1u] = roles[index];
        }
    }

    pl_u32 table_base_count = 0u;
    status = pl_x86_table_base_write(
        image, executable_image, entries, primary_unique,
        tables, table_capacity,
        table_scratch, table_scratch_capacity,
        analysis_workspace, analysis_workspace_bytes,
        &table_base_count);
    if (status) return status;
    entry_sink metadata = {
        entries + primary.count, roles + primary.count,
        entry_capacity - primary.count, 0u, 1
    };
    code_grid_sink grids = {
        code_grids, code_grid_capacity, 0u, 1
    };
    pl_u32 table_targets = 0u;
    status = collect_metadata(
        image, executable_image, tables, table_base_count, 1,
        analysis_workspace, analysis_workspace_bytes,
        &metadata, &grids, &table_targets);
    if (!status)
        status = collect_alternative_grids(
            image, executable_image, &metadata, &grids);
    if (status || metadata.count > entry_capacity - primary.count
            || primary.count > 0xffffffffu - metadata.count
            || scratch_capacity < primary.count
            || scratch_capacity < metadata.count)
        return PL_ERROR_ELF_RANGE;

    pl_u64 *metadata_values = entries + primary.count;
    pl_u8 *metadata_roles = roles + primary.count;
    radix_sort(
        metadata_values, scratch, metadata_roles, role_scratch,
        metadata.count);
    pl_u32 metadata_unique = 0u;
    pl_u32 primary_at = 0u;
    for (pl_u32 index = 0u; index < metadata.count;) {
        pl_u64 value = metadata_values[index];
        pl_u8 role = metadata_roles[index];
        pl_u32 next = index + 1u;
        while (next < metadata.count && metadata_values[next] == value)
            role |= metadata_roles[next++];
        while (primary_at < primary_unique
                && entries[primary_at] < value)
            ++primary_at;
        if (primary_at < primary_unique && entries[primary_at] == value) {
            roles[primary_at] |= role;
        } else {
            entries[primary_unique + metadata_unique++] = value;
            roles[primary_unique + metadata_unique - 1u] = role;
        }
        index = next;
    }
    out->candidate_count = primary.count + metadata.count;
    out->entry_count = primary_unique + metadata_unique;
    out->primary_candidate_count = primary.count;
    out->primary_count = primary_unique;
    out->table_base_candidate_count = table_capacity;
    out->table_base_count = table_base_count;
    out->table_target_count = table_targets;
    out->address_observable_count = 0u;
    out->code_grid_candidate_count = code_grid_capacity;
    out->code_grid_count = grids.count;
    for (pl_u32 index = 0u; index < out->entry_count; ++index) {
        if (!(roles[index] & PL_X86_ENTRY_EXECUTION_ROOT))
            return PL_ERROR_ELF;
        if (roles[index] & PL_X86_ENTRY_ADDRESS_VALUE)
            ++out->address_observable_count;
    }
    status = collect_observed_function_grids(
        image, executable_image, entries, roles,
        primary_unique, out->entry_count, &grids);
    if (status) return status;
    out->code_grid_count = grids.count;
    return 0;
}

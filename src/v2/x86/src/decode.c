/* Linked-x86 source projection and decoder normalization. */

#include <x86/decode.h>

#include <Zydis/Zydis.h>

static void zero_bytes(void *destination, pl_u64 bytes)
{
    pl_u8 *out = destination;
    for (pl_u64 index = 0u; index < bytes; ++index) out[index] = 0u;
}

static int add_overflows(pl_u64 left, pl_u64 right)
{
    return left > ~0ull - right;
}

static pl_u64 map_end(const pl_x86_map *map)
{
    return map->address + map->memory_bytes;
}

int pl_x86_image_validate(const pl_x86_image *image)
{
    if (!image || (!image->maps && image->map_count)) return PL_ERROR_X86_MAP;
    pl_u64 prior_end = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        if (!map->memory_bytes || map->file_bytes > map->memory_bytes
                || (map->file_bytes && !map->bytes)
                || add_overflows(map->address, map->memory_bytes)
                || (index && map->address < prior_end))
            return PL_ERROR_X86_MAP;
        prior_end = map_end(map);
    }
    return 0;
}

static int section_segment(const pl_elf_image *elf,
                           const pl_elf_section *section,
                           pl_elf_segment *out)
{
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        int status = pl_elf_program(elf, index, &segment);
        if (status) return status;
        if (segment.type == PL_ELF_SEGMENT_LOAD
                && section->address >= segment.virtual_address
                && section->address - segment.virtual_address
                    <= segment.memory_bytes
                && section->memory_bytes
                    <= segment.memory_bytes
                     - (section->address - segment.virtual_address)) {
            *out = segment;
            return 0;
        }
    }
    return PL_ERROR_X86_MAP;
}

int pl_x86_elf_map_count(const pl_elf_image *elf, pl_u32 *count)
{
    if (!elf || !count) return PL_ERROR_X86_MAP;
    pl_u32 found = 0u;
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        int status = pl_elf_program(elf, index, &segment);
        if (status) return status;
        if (pl_elf_segment_is_executable(&segment)) {
            if (found == 0xffffffffu) return PL_ERROR_X86_CAPACITY;
            ++found;
        }
    }
    /* Linux vmlinux deliberately carries executable init/alternative sections
     * in a writable PT_LOAD.  They are real instruction coordinates even
     * though PF_X alone does not name them. */
    for (pl_u32 index = 0u; index < elf->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, index, &section);
        if (status) return status;
        if (!pl_elf_section_is_executable(&section)) continue;
        pl_elf_segment segment;
        status = section_segment(elf, &section, &segment);
        if (status) return status;
        if (pl_elf_segment_is_executable(&segment)) continue;
        if (found == 0xffffffffu) return PL_ERROR_X86_CAPACITY;
        ++found;
    }
    *count = found;
    return 0;
}

static void swap_map(pl_x86_map *left, pl_x86_map *right)
{
    pl_x86_map value = *left;
    *left = *right;
    *right = value;
}

static void sort_maps(pl_x86_map *maps, pl_u32 count)
{
    for (pl_u32 index = 1u; index < count; ++index) {
        pl_u32 at = index;
        while (at && maps[at].address < maps[at - 1u].address) {
            swap_map(&maps[at], &maps[at - 1u]);
            --at;
        }
    }
}

int pl_x86_image_from_elf_coordinates(
    const pl_elf_image *elf, pl_u64 load_bias, pl_u64 generation,
    pl_u32 coordinates, pl_x86_map *maps, pl_u32 capacity,
    pl_x86_image *out)
{
    if (!elf || !out || (!maps && capacity)) return PL_ERROR_X86_MAP;
    if (coordinates != PL_X86_ELF_VIRTUAL
            && coordinates != PL_X86_ELF_PHYSICAL)
        return PL_ERROR_X86_MAP;
    pl_u32 required;
    int status = pl_x86_elf_map_count(elf, &required);
    if (status) return status;
    if (required > capacity) return PL_ERROR_X86_CAPACITY;
    pl_u32 written = 0u;
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        status = pl_elf_program(elf, index, &segment);
        if (status) return status;
        if (!pl_elf_segment_is_executable(&segment)) continue;
        pl_u64 source_address = coordinates == PL_X86_ELF_VIRTUAL
                              ? segment.virtual_address
                              : segment.physical_address;
        if (add_overflows(source_address, load_bias))
            return PL_ERROR_X86_MAP;
        maps[written].bytes = elf->bytes + segment.file_offset;
        maps[written].address = source_address + load_bias;
        maps[written].file_bytes = segment.file_bytes;
        maps[written].memory_bytes = segment.memory_bytes;
        maps[written].flags = segment.flags;
        maps[written].generation = generation;
        ++written;
    }
    for (pl_u32 index = 0u; index < elf->section_count; ++index) {
        pl_elf_section section;
        status = pl_elf_section_read(elf, index, &section);
        if (status) return status;
        if (!pl_elf_section_is_executable(&section)) continue;
        pl_elf_segment segment;
        status = section_segment(elf, &section, &segment);
        if (status) return status;
        if (pl_elf_segment_is_executable(&segment)) continue;
        pl_u64 source_address;
        if (coordinates == PL_X86_ELF_VIRTUAL) {
            source_address = section.address;
        } else {
            pl_u64 relative = section.address - segment.virtual_address;
            if (add_overflows(segment.physical_address, relative))
                return PL_ERROR_X86_MAP;
            source_address = segment.physical_address + relative;
        }
        if (add_overflows(source_address, load_bias))
            return PL_ERROR_X86_MAP;
        maps[written].bytes = section.file_bytes
                            ? elf->bytes + section.file_offset : 0;
        maps[written].address = source_address + load_bias;
        maps[written].file_bytes = section.file_bytes;
        maps[written].memory_bytes = section.memory_bytes;
        maps[written].flags = segment.flags | PL_ELF_FLAG_EXECUTE;
        maps[written].generation = generation;
        ++written;
    }
    sort_maps(maps, written);
    if (add_overflows(elf->entry, load_bias)) return PL_ERROR_X86_MAP;
    out->maps = maps;
    out->map_count = written;
    out->reserved = 0u;
    out->entry = elf->entry + load_bias;
    return pl_x86_image_validate(out);
}

int pl_x86_image_from_elf(const pl_elf_image *elf, pl_u64 load_bias,
                          pl_u64 generation, pl_x86_map *maps,
                          pl_u32 capacity, pl_x86_image *out)
{
    return pl_x86_image_from_elf_coordinates(
        elf, load_bias, generation, PL_X86_ELF_VIRTUAL,
        maps, capacity, out);
}

static int executable_section_count(const pl_elf_image *elf, pl_u32 *count)
{
    if (!elf || !count) return PL_ERROR_X86_MAP;
    pl_u32 found = 0u;
    for (pl_u32 index = 0u; index < elf->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, index, &section);
        if (status) return status;
        if (!pl_elf_section_is_executable(&section)) continue;
        pl_elf_segment segment;
        status = section_segment(elf, &section, &segment);
        if (status) return status;
        if (found == 0xffffffffu) return PL_ERROR_X86_CAPACITY;
        ++found;
    }
    *count = found;
    return 0;
}

int pl_x86_elf_code_map_count(const pl_elf_image *elf, pl_u32 *count)
{
    pl_u32 sections = 0u;
    int status = executable_section_count(elf, &sections);
    if (status) return status;
    if (!sections) return pl_x86_elf_map_count(elf, count);
    *count = sections;
    return 0;
}

int pl_x86_image_from_elf_code_coordinates(
    const pl_elf_image *elf, pl_u64 load_bias, pl_u64 generation,
    pl_u32 coordinates, pl_x86_map *maps, pl_u32 capacity,
    pl_x86_image *out)
{
    if (!elf || !out || (!maps && capacity)) return PL_ERROR_X86_MAP;
    if (coordinates != PL_X86_ELF_VIRTUAL
            && coordinates != PL_X86_ELF_PHYSICAL)
        return PL_ERROR_X86_MAP;
    pl_u32 required = 0u;
    int status = executable_section_count(elf, &required);
    if (status) return status;
    if (!required)
        return pl_x86_image_from_elf_coordinates(
            elf, load_bias, generation, coordinates,
            maps, capacity, out);
    if (required > capacity) return PL_ERROR_X86_CAPACITY;

    pl_u32 written = 0u;
    for (pl_u32 index = 0u; index < elf->section_count; ++index) {
        pl_elf_section section;
        status = pl_elf_section_read(elf, index, &section);
        if (status) return status;
        if (!pl_elf_section_is_executable(&section)) continue;
        pl_elf_segment segment;
        status = section_segment(elf, &section, &segment);
        if (status) return status;
        pl_u64 source_address;
        if (coordinates == PL_X86_ELF_VIRTUAL) {
            source_address = section.address;
        } else {
            pl_u64 relative = section.address - segment.virtual_address;
            if (add_overflows(segment.physical_address, relative))
                return PL_ERROR_X86_MAP;
            source_address = segment.physical_address + relative;
        }
        if (add_overflows(source_address, load_bias))
            return PL_ERROR_X86_MAP;
        maps[written].bytes = section.file_bytes
                            ? elf->bytes + section.file_offset : 0;
        maps[written].address = source_address + load_bias;
        maps[written].file_bytes = section.file_bytes;
        maps[written].memory_bytes = section.memory_bytes;
        maps[written].flags = segment.flags | PL_ELF_FLAG_EXECUTE;
        maps[written].generation = generation;
        ++written;
    }
    if (written != required) return PL_ERROR_X86_MAP;
    sort_maps(maps, written);
    if (add_overflows(elf->entry, load_bias)) return PL_ERROR_X86_MAP;
    out->maps = maps;
    out->map_count = written;
    out->reserved = 0u;
    out->entry = elf->entry + load_bias;
    return pl_x86_image_validate(out);
}

int pl_x86_image_from_elf_code(
    const pl_elf_image *elf, pl_u64 load_bias, pl_u64 generation,
    pl_x86_map *maps, pl_u32 capacity, pl_x86_image *out)
{
    return pl_x86_image_from_elf_code_coordinates(
        elf, load_bias, generation, PL_X86_ELF_VIRTUAL,
        maps, capacity, out);
}

static int same_map(const pl_x86_map *left, const pl_x86_map *right)
{
    return left->bytes == right->bytes
        && left->address == right->address
        && left->file_bytes == right->file_bytes
        && left->memory_bytes == right->memory_bytes
        && left->flags == right->flags
        && left->generation == right->generation;
}

static int maps_contain(const pl_x86_map *maps, pl_u32 count, pl_u64 address)
{
    for (pl_u32 index = 0u; index < count; ++index)
        if (address >= maps[index].address
                && address - maps[index].address < maps[index].memory_bytes)
            return 1;
    return 0;
}

int pl_x86_image_from_elf_aliases(
    const pl_elf_image *elf, pl_u64 virtual_bias, pl_u64 physical_bias,
    pl_u64 generation, pl_x86_map *maps, pl_u32 capacity,
    pl_x86_image *out)
{
    if (!elf || !maps || !out) return PL_ERROR_X86_MAP;
    pl_u32 one = 0u;
    int status = pl_x86_elf_map_count(elf, &one);
    if (status) return status;
    if (one > capacity / 2u) return PL_ERROR_X86_CAPACITY;
    pl_x86_image virtual_image, physical_image;
    status = pl_x86_image_from_elf_coordinates(
        elf, virtual_bias, generation, PL_X86_ELF_VIRTUAL,
        maps, one, &virtual_image);
    if (status) return status;
    status = pl_x86_image_from_elf_coordinates(
        elf, physical_bias, generation, PL_X86_ELF_PHYSICAL,
        maps + one, one, &physical_image);
    if (status) return status;
    pl_u32 total = one * 2u;
    sort_maps(maps, total);
    pl_u32 written = 0u;
    for (pl_u32 index = 0u; index < total; ++index) {
        if (written && maps[index].address == maps[written - 1u].address) {
            if (!same_map(&maps[index], &maps[written - 1u]))
                return PL_ERROR_X86_MAP;
            continue;
        }
        maps[written++] = maps[index];
    }
    out->maps = maps;
    out->map_count = written;
    out->reserved = 0u;
    if (!add_overflows(elf->entry, physical_bias)
            && maps_contain(
                maps, written, elf->entry + physical_bias))
        out->entry = elf->entry + physical_bias;
    else if (!add_overflows(elf->entry, virtual_bias)
            && maps_contain(
                maps, written, elf->entry + virtual_bias))
        out->entry = elf->entry + virtual_bias;
    else
        return PL_ERROR_X86_MAP;
    (void)virtual_image;
    (void)physical_image;
    return pl_x86_image_validate(out);
}

static pl_u32 find_map(const pl_x86_image *image, pl_u64 address)
{
    pl_u32 lower = 0u, upper = image->map_count;
    while (lower < upper) {
        pl_u32 middle = lower + (upper - lower) / 2u;
        if (image->maps[middle].address <= address) lower = middle + 1u;
        else upper = middle;
    }
    if (!lower) return image->map_count;
    pl_u32 index = lower - 1u;
    return address < map_end(&image->maps[index]) ? index : image->map_count;
}

int pl_x86_image_contains(const pl_x86_image *image, pl_u64 address)
{
    if (pl_x86_image_validate(image)) return 0;
    return find_map(image, address) < image->map_count;
}

static int image_read_validated(const pl_x86_image *image, pl_u64 address,
                                pl_u8 *bytes, pl_u32 capacity, pl_u32 *read)
{
    pl_u32 produced = 0u;
    pl_u32 index = find_map(image, address);
    while (produced < capacity && index < image->map_count) {
        const pl_x86_map *map = &image->maps[index];
        if (address < map->address || address >= map_end(map)) break;
        pl_u64 offset = address - map->address;
        pl_u64 available = map->memory_bytes - offset;
        pl_u64 wanted = capacity - produced;
        if (available > wanted) available = wanted;
        for (pl_u64 at = 0u; at < available; ++at) {
            pl_u64 source = offset + at;
            bytes[produced + (pl_u32)at] = source < map->file_bytes
                                         ? map->bytes[source] : 0u;
        }
        produced += (pl_u32)available;
        address += available;
        if (produced == capacity) break;
        ++index;
        if (index >= image->map_count || image->maps[index].address != address)
            break;
    }
    *read = produced;
    return 0;
}

int pl_x86_image_read(const pl_x86_image *image, pl_u64 address,
                      pl_u8 *bytes, pl_u32 capacity, pl_u32 *read)
{
    if (!image || !read || (!bytes && capacity)) return PL_ERROR_X86_MAP;
    int status = pl_x86_image_validate(image);
    return status ? status
                  : image_read_validated(
                      image, address, bytes, capacity, read);
}

int pl_x86_image_reader_open(
    pl_x86_image_reader *reader, const pl_x86_image *image)
{
    if (!reader || pl_x86_image_validate(image)) return PL_ERROR_X86_MAP;
    reader->image = image;
    return 0;
}

int pl_x86_image_materialize(
    const pl_x86_image_reader *reader, pl_u64 address,
    pl_u8 *bytes, pl_u32 count)
{
    if (!reader || !reader->image || (!bytes && count)
            || (count && add_overflows(address, count)))
        return PL_ERROR_X86_MAP;
    for (pl_u32 index = 0u; index < count; ++index) bytes[index] = 0u;
    if (!count) return 0;
    const pl_x86_image *image = reader->image;
    pl_u64 end = address + count;
    pl_u32 low = 0u, high = image->map_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (map_end(&image->maps[middle]) <= address) low = middle + 1u;
        else high = middle;
    }
    for (pl_u32 rank = low; rank < image->map_count; ++rank) {
        const pl_x86_map *map = &image->maps[rank];
        if (map->address >= end) break;
        pl_u64 begin = map->address > address ? map->address : address;
        pl_u64 finish = map_end(map) < end ? map_end(map) : end;
        for (pl_u64 at = begin; at < finish; ++at) {
            pl_u64 source = at - map->address;
            if (source < map->file_bytes)
                bytes[at - address] = map->bytes[source];
        }
    }
    return 0;
}

static pl_u8 register_class(ZydisRegisterClass value)
{
    switch (value) {
    case ZYDIS_REGCLASS_GPR8:
    case ZYDIS_REGCLASS_GPR16:
    case ZYDIS_REGCLASS_GPR32:
    case ZYDIS_REGCLASS_GPR64: return PL_X86_REGISTER_GPR;
    case ZYDIS_REGCLASS_X87: return PL_X86_REGISTER_X87;
    case ZYDIS_REGCLASS_MMX: return PL_X86_REGISTER_MMX;
    case ZYDIS_REGCLASS_XMM:
    case ZYDIS_REGCLASS_YMM:
    case ZYDIS_REGCLASS_ZMM: return PL_X86_REGISTER_VECTOR;
    case ZYDIS_REGCLASS_TMM: return PL_X86_REGISTER_TILE;
    case ZYDIS_REGCLASS_FLAGS: return PL_X86_REGISTER_FLAGS;
    case ZYDIS_REGCLASS_IP: return PL_X86_REGISTER_IP;
    case ZYDIS_REGCLASS_SEGMENT: return PL_X86_REGISTER_SEGMENT;
    case ZYDIS_REGCLASS_TABLE: return PL_X86_REGISTER_TABLE;
    case ZYDIS_REGCLASS_TEST: return PL_X86_REGISTER_TEST;
    case ZYDIS_REGCLASS_CONTROL: return PL_X86_REGISTER_CONTROL;
    case ZYDIS_REGCLASS_DEBUG: return PL_X86_REGISTER_DEBUG;
    case ZYDIS_REGCLASS_MASK: return PL_X86_REGISTER_MASK;
    case ZYDIS_REGCLASS_BOUND: return PL_X86_REGISTER_BOUND;
    default: return PL_X86_REGISTER_NONE;
    }
}

static pl_x86_register normalize_register(ZydisRegister value)
{
    pl_x86_register out = { 0u, 0u, 0u, 0u };
    if (value == ZYDIS_REGISTER_NONE) return out;
    ZydisRegisterClass source_class = ZydisRegisterGetClass(value);
    out.class_id = register_class(source_class);
    ZyanI8 source_id = ZydisRegisterGetId(value);
    out.index = source_id < 0 ? 0u : (pl_u8)source_id;
    out.bits = (pl_u16)ZydisRegisterGetWidth(
        ZYDIS_MACHINE_MODE_LONG_64, value);
    if (value >= ZYDIS_REGISTER_AH && value <= ZYDIS_REGISTER_BH) {
        out.index = (pl_u8)(value - ZYDIS_REGISTER_AH);
        out.flags |= PL_X86_REGISTER_HIGH8;
    } else if (source_class == ZYDIS_REGCLASS_GPR8
            && value >= ZYDIS_REGISTER_SPL) {
        out.index = (pl_u8)(out.index - 4u);
    }
    return out;
}

static pl_u32 operand_actions(const ZydisDecodedOperand *operand)
{
    pl_u32 flags = 0u;
    if (operand->actions & ZYDIS_OPERAND_ACTION_READ)
        flags |= PL_X86_OPERAND_READ;
    if (operand->actions & ZYDIS_OPERAND_ACTION_WRITE)
        flags |= PL_X86_OPERAND_WRITE;
    if (operand->actions & ZYDIS_OPERAND_ACTION_CONDREAD)
        flags |= PL_X86_OPERAND_CONDITIONAL_READ;
    if (operand->actions & ZYDIS_OPERAND_ACTION_CONDWRITE)
        flags |= PL_X86_OPERAND_CONDITIONAL_WRITE;
    if (operand->visibility == ZYDIS_OPERAND_VISIBILITY_EXPLICIT)
        flags |= PL_X86_OPERAND_EXPLICIT;
    return flags;
}

static void normalize_operand(const ZydisDecodedOperand *source,
                              pl_x86_operand *out)
{
    zero_bytes(out, sizeof *out);
    out->bits = source->size;
    out->flags = operand_actions(source);
    switch (source->type) {
    case ZYDIS_OPERAND_TYPE_REGISTER:
        out->kind = PL_X86_OPERAND_REGISTER;
        out->value.reg = normalize_register(source->reg.value);
        break;
    case ZYDIS_OPERAND_TYPE_MEMORY:
        out->kind = PL_X86_OPERAND_MEMORY;
        out->value.memory.segment = normalize_register(source->mem.segment);
        out->value.memory.base = normalize_register(source->mem.base);
        out->value.memory.index = normalize_register(source->mem.index);
        out->value.memory.scale = source->mem.scale;
        out->value.memory.has_displacement = source->mem.disp.has_displacement;
        out->value.memory.displacement = source->mem.disp.value;
        if (source->mem.type == ZYDIS_MEMOP_TYPE_AGEN
                || source->mem.type == ZYDIS_MEMOP_TYPE_MIB)
            out->flags |= PL_X86_OPERAND_ADDRESS_ONLY;
        break;
    case ZYDIS_OPERAND_TYPE_IMMEDIATE:
        out->kind = PL_X86_OPERAND_IMMEDIATE;
        out->value.immediate = source->imm.value.u;
        if (source->imm.is_relative) out->flags |= PL_X86_OPERAND_RELATIVE;
        if (source->imm.is_signed) out->flags |= PL_X86_OPERAND_SIGNED;
        break;
    case ZYDIS_OPERAND_TYPE_POINTER:
        out->kind = PL_X86_OPERAND_POINTER;
        out->value.pointer.segment = source->ptr.segment;
        out->value.pointer.offset = source->ptr.offset;
        break;
    default:
        out->kind = PL_X86_OPERAND_NONE;
        break;
    }
}

static void set_fault(pl_x86_instruction *out, pl_u8 status, pl_u8 vector)
{
    out->status = status;
    out->flow = PL_X86_FLOW_FAULT;
    out->family = PL_X86_FAMILY_INVALID;
    out->operation = PL_X86_OPERATION_FAULT;
    out->condition = 0xffu;
    out->trap_vector = vector;
    out->flags = PL_X86_INSTRUCTION_MAY_TRAP
               | PL_X86_INSTRUCTION_PRECISE_CUT
               | PL_X86_INSTRUCTION_BARRIER;
}

static int category_is_barrier(ZydisInstructionCategory category)
{
    return category == ZYDIS_CATEGORY_INTERRUPT
        || category == ZYDIS_CATEGORY_IO
        || category == ZYDIS_CATEGORY_IOSTRINGOP
        || category == ZYDIS_CATEGORY_SYSCALL
        || category == ZYDIS_CATEGORY_SYSRET
        || category == ZYDIS_CATEGORY_SYSTEM
        || category == ZYDIS_CATEGORY_SERIALIZE
        || category == ZYDIS_CATEGORY_UINTR
        || category == ZYDIS_CATEGORY_VTX;
}

/* This predicate belongs to the narrower delivery projection, not to the
 * linked-x86 source language.  An ordinary optimized ELF can execute on a CPU
 * whose CPUID is a strict superset of that projection, so the post-link x86
 * compiler must retain such instructions as exact native extension cuts.
 * Collapsing them to #UD while copying their original bytes makes analysis and
 * execution disagree on precisely the hosts where the extension is useful. */
static int outside_delivery_profile(ZydisISASet isa_set)
{
    if (isa_set >= ZYDIS_ISA_SET_KNCE
            && isa_set <= ZYDIS_ISA_SET_KNC_PF_HINT)
        return 1;
    if (isa_set == ZYDIS_ISA_SET_AMD_INVLPGB)
        return 1;
    if (isa_set == ZYDIS_ISA_SET_PBNDKB)
        return 1;
    if (isa_set == ZYDIS_ISA_SET_PADLOCK_ACE
            || isa_set == ZYDIS_ISA_SET_PADLOCK_PHE
            || isa_set == ZYDIS_ISA_SET_PADLOCK_PMM
            || isa_set == ZYDIS_ISA_SET_PADLOCK_RNG)
        return 1;
    if (isa_set == ZYDIS_ISA_SET_CLZERO
            || isa_set == ZYDIS_ISA_SET_WRMSRNS
            || isa_set == ZYDIS_ISA_SET_RDPRU)
        return 1;
    if (!(PL_X86_CPUID_80000001_ECX & (1u << 6u))
            && isa_set == ZYDIS_ISA_SET_SSE4A)
        return 1;
    /* TBM is an AMD extension and its CPUID.80000001H:ECX feature bit is not
     * published by the fixed CPU profile.  All TBM encodings therefore have
     * the same architectural future: #UD before any operand is observed. */
    if (!(PL_X86_CPUID_80000001_ECX & (1u << 21u))
            && isa_set == ZYDIS_ISA_SET_TBM)
        return 1;

    /* AVX requires both the architectural feature and OSXSAVE.  This fixed
     * CPU publishes neither, so every VEX/EVEX arithmetic family shares #UD
     * without allocating YMM/ZMM state that no legal execution can observe. */
    if (!(PL_X86_CPUID_1_ECX & (1u << 28u))
            && ((isa_set >= ZYDIS_ISA_SET_AVX
                 && isa_set <= ZYDIS_ISA_SET_AVX_VNNI_INT8)
                || isa_set == ZYDIS_ISA_SET_FMA
                || isa_set == ZYDIS_ISA_SET_FMA4
                || isa_set == ZYDIS_ISA_SET_VAES
                || isa_set == ZYDIS_ISA_SET_VPCLMULQDQ
                || isa_set == ZYDIS_ISA_SET_XOP))
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 9u))
            && (isa_set == ZYDIS_ISA_SET_SSSE3
                || isa_set == ZYDIS_ISA_SET_SSSE3MMX))
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 19u))
            && isa_set == ZYDIS_ISA_SET_SSE4)
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 3u))
            && (isa_set == ZYDIS_ISA_SET_MONITOR
                || isa_set == ZYDIS_ISA_SET_MONITORX))
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 5u))
            && isa_set == ZYDIS_ISA_SET_VTX)
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 6u))
            && isa_set == ZYDIS_ISA_SET_SMX)
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 26u))
            && (isa_set == ZYDIS_ISA_SET_XSAVE
                || isa_set == ZYDIS_ISA_SET_XSAVEC
                || isa_set == ZYDIS_ISA_SET_XSAVEOPT
                || isa_set == ZYDIS_ISA_SET_XSAVES))
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 1u))
            && isa_set == ZYDIS_ISA_SET_PCLMULQDQ)
        return 1;
    if (!(PL_X86_CPUID_1_ECX & (1u << 25u))
            && isa_set == ZYDIS_ISA_SET_AES)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 2u))
            && (isa_set == ZYDIS_ISA_SET_SGX
                || isa_set == ZYDIS_ISA_SET_SGX_ENCLV))
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 8u))
            && isa_set == ZYDIS_ISA_SET_BMI2)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 19u))
            && isa_set == ZYDIS_ISA_SET_ADOX_ADCX)
        return 1;
    if (!(PL_X86_CPUID_7_0_EDX & (1u << 18u))
            && isa_set == ZYDIS_ISA_SET_PCONFIG)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 20u))
            && isa_set == ZYDIS_ISA_SET_SMAP)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 23u))
            && isa_set == ZYDIS_ISA_SET_CLFLUSHOPT)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 11u))
            && (isa_set == ZYDIS_ISA_SET_RTM
                || isa_set == ZYDIS_ISA_SET_TSX_LDTRK))
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 14u))
            && isa_set == ZYDIS_ISA_SET_MPX)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 10u))
            && isa_set == ZYDIS_ISA_SET_INVPCID)
        return 1;
    if (!(PL_X86_CPUID_7_0_ECX & (1u << 25u))
            && isa_set == ZYDIS_ISA_SET_CLDEMOTE)
        return 1;
    if (!(PL_X86_CPUID_7_0_ECX & (1u << 22u))
            && isa_set == ZYDIS_ISA_SET_RDPID)
        return 1;
    if (!(PL_X86_CPUID_7_0_ECX & (1u << 5u))
            && isa_set == ZYDIS_ISA_SET_WAITPKG)
        return 1;
    if (!(PL_X86_CPUID_7_0_ECX & (1u << 7u))
            && isa_set == ZYDIS_ISA_SET_CET)
        return 1;
    if (!(PL_X86_CPUID_7_0_EDX & (1u << 24u))
            && isa_set == ZYDIS_ISA_SET_AMX_TILE)
        return 1;
    if (!(PL_X86_CPUID_7_0_EBX & (1u << 29u))
            && (isa_set == ZYDIS_ISA_SET_SHA
                || isa_set == ZYDIS_ISA_SET_SHA512))
        return 1;
    if (!(PL_X86_CPUID_80000001_EDX & (1u << 31u))
            && isa_set == ZYDIS_ISA_SET_AMD3DNOW)
        return 1;
    return 0;
}

static void classify_control(const ZydisDecodedInstruction *source,
                             pl_x86_instruction *out)
{
    switch (source->meta.category) {
    case ZYDIS_CATEGORY_COND_BR:
        out->flow = PL_X86_FLOW_CONDITIONAL;
        out->family = PL_X86_FAMILY_BRANCH;
        out->operation = PL_X86_OPERATION_BRANCH;
        out->flags |= PL_X86_INSTRUCTION_FALLTHROUGH
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
        break;
    case ZYDIS_CATEGORY_UNCOND_BR:
        out->flow = PL_X86_FLOW_JUMP;
        out->family = PL_X86_FAMILY_BRANCH;
        out->operation = PL_X86_OPERATION_BRANCH;
        out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT;
        break;
    case ZYDIS_CATEGORY_CALL:
        out->flow = PL_X86_FLOW_CALL;
        out->family = PL_X86_FAMILY_CALL;
        out->operation = PL_X86_OPERATION_CALL;
        out->flags |= PL_X86_INSTRUCTION_FALLTHROUGH
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
        break;
    case ZYDIS_CATEGORY_RET:
        out->flow = PL_X86_FLOW_RETURN;
        out->family = PL_X86_FAMILY_RETURN;
        out->operation = PL_X86_OPERATION_RETURN;
        out->flags |= PL_X86_INSTRUCTION_INDIRECT
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
        break;
    case ZYDIS_CATEGORY_INTERRUPT:
        out->flow = PL_X86_FLOW_INTERRUPT;
        out->family = PL_X86_FAMILY_INTERRUPT;
        out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER
                    | PL_X86_INSTRUCTION_MAY_TRAP;
        break;
    default:
        if (category_is_barrier(source->meta.category)) {
            out->flow = PL_X86_FLOW_SYSTEM;
            out->family = PL_X86_FAMILY_SYSTEM;
            out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    }
}

static int mnemonic_condition(ZydisMnemonic mnemonic)
{
    switch (mnemonic) {
    case ZYDIS_MNEMONIC_JO:
    case ZYDIS_MNEMONIC_CMOVO:
    case ZYDIS_MNEMONIC_SETO: return 0;
    case ZYDIS_MNEMONIC_JNO:
    case ZYDIS_MNEMONIC_CMOVNO:
    case ZYDIS_MNEMONIC_SETNO: return 1;
    case ZYDIS_MNEMONIC_JB:
    case ZYDIS_MNEMONIC_CMOVB:
    case ZYDIS_MNEMONIC_SETB: return 2;
    case ZYDIS_MNEMONIC_JNB:
    case ZYDIS_MNEMONIC_CMOVNB:
    case ZYDIS_MNEMONIC_SETNB: return 3;
    case ZYDIS_MNEMONIC_JZ:
    case ZYDIS_MNEMONIC_CMOVZ:
    case ZYDIS_MNEMONIC_SETZ: return 4;
    case ZYDIS_MNEMONIC_JNZ:
    case ZYDIS_MNEMONIC_CMOVNZ:
    case ZYDIS_MNEMONIC_SETNZ: return 5;
    case ZYDIS_MNEMONIC_JBE:
    case ZYDIS_MNEMONIC_CMOVBE:
    case ZYDIS_MNEMONIC_SETBE: return 6;
    case ZYDIS_MNEMONIC_JNBE:
    case ZYDIS_MNEMONIC_CMOVNBE:
    case ZYDIS_MNEMONIC_SETNBE: return 7;
    case ZYDIS_MNEMONIC_JS:
    case ZYDIS_MNEMONIC_CMOVS:
    case ZYDIS_MNEMONIC_SETS: return 8;
    case ZYDIS_MNEMONIC_JNS:
    case ZYDIS_MNEMONIC_CMOVNS:
    case ZYDIS_MNEMONIC_SETNS: return 9;
    case ZYDIS_MNEMONIC_JP:
    case ZYDIS_MNEMONIC_CMOVP:
    case ZYDIS_MNEMONIC_SETP: return 10;
    case ZYDIS_MNEMONIC_JNP:
    case ZYDIS_MNEMONIC_CMOVNP:
    case ZYDIS_MNEMONIC_SETNP: return 11;
    case ZYDIS_MNEMONIC_JL:
    case ZYDIS_MNEMONIC_CMOVL:
    case ZYDIS_MNEMONIC_SETL: return 12;
    case ZYDIS_MNEMONIC_JNL:
    case ZYDIS_MNEMONIC_CMOVNL:
    case ZYDIS_MNEMONIC_SETNL: return 13;
    case ZYDIS_MNEMONIC_JLE:
    case ZYDIS_MNEMONIC_CMOVLE:
    case ZYDIS_MNEMONIC_SETLE: return 14;
    case ZYDIS_MNEMONIC_JNLE:
    case ZYDIS_MNEMONIC_CMOVNLE:
    case ZYDIS_MNEMONIC_SETNLE: return 15;
    default: return -1;
    }
}

static void classify_mnemonic(const ZydisDecodedInstruction *source,
                              pl_x86_instruction *out)
{
    int condition = mnemonic_condition(source->mnemonic);
    if (condition >= 0) {
        out->condition = (pl_u8)condition;
        if (source->meta.category == ZYDIS_CATEGORY_CMOV)
            out->operation = PL_X86_OPERATION_CONDITIONAL_MOVE;
        else if (source->meta.category == ZYDIS_CATEGORY_SETCC)
            out->operation = PL_X86_OPERATION_CONDITIONAL_SET;
    }
    switch (source->mnemonic) {
    case ZYDIS_MNEMONIC_LOOP:
        out->operation = PL_X86_OPERATION_LOOP;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_LOOPE:
        out->operation = PL_X86_OPERATION_LOOP;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_LOOPNE:
        out->operation = PL_X86_OPERATION_LOOP;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_JCXZ:
    case ZYDIS_MNEMONIC_JECXZ:
    case ZYDIS_MNEMONIC_JRCXZ:
        out->operation = PL_X86_OPERATION_COUNT_ZERO_BRANCH;
        break;
    case ZYDIS_MNEMONIC_LEAVE:
        out->operation = PL_X86_OPERATION_LEAVE;
        break;
    case ZYDIS_MNEMONIC_CBW:
        out->operation = PL_X86_OPERATION_ACCUMULATOR_EXTEND;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_CWDE:
        out->operation = PL_X86_OPERATION_ACCUMULATOR_EXTEND;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_CDQE:
        out->operation = PL_X86_OPERATION_ACCUMULATOR_EXTEND;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_CWD:
        out->operation = PL_X86_OPERATION_HIGH_EXTEND;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_CDQ:
        out->operation = PL_X86_OPERATION_HIGH_EXTEND;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_CQO:
        out->operation = PL_X86_OPERATION_HIGH_EXTEND;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_PUSH:
        out->operation = PL_X86_OPERATION_PUSH;
        break;
    case ZYDIS_MNEMONIC_POP:
        out->operation = PL_X86_OPERATION_POP;
        break;
    case ZYDIS_MNEMONIC_PUSHF:
    case ZYDIS_MNEMONIC_PUSHFD:
    case ZYDIS_MNEMONIC_PUSHFQ:
        out->operation = PL_X86_OPERATION_PUSH_FLAGS;
        break;
    case ZYDIS_MNEMONIC_POPF:
    case ZYDIS_MNEMONIC_POPFD:
    case ZYDIS_MNEMONIC_POPFQ:
        out->operation = PL_X86_OPERATION_POP_FLAGS;
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    case ZYDIS_MNEMONIC_LAHF:
        out->operation = PL_X86_OPERATION_LOAD_FLAGS_LOW;
        break;
    case ZYDIS_MNEMONIC_SAHF:
        out->operation = PL_X86_OPERATION_STORE_FLAGS_LOW;
        break;
    case ZYDIS_MNEMONIC_BT:
        out->operation = PL_X86_OPERATION_BIT_TEST;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_BTS:
        out->operation = PL_X86_OPERATION_BIT_TEST;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_BTR:
        out->operation = PL_X86_OPERATION_BIT_TEST;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_BTC:
        out->operation = PL_X86_OPERATION_BIT_TEST;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_XLAT:
        out->operation = PL_X86_OPERATION_TRANSLATE_BYTE;
        break;
    case ZYDIS_MNEMONIC_BSWAP:
        out->operation = PL_X86_OPERATION_BYTE_SWAP;
        break;
    case ZYDIS_MNEMONIC_ENTER:
        out->operation = PL_X86_OPERATION_ENTER;
        break;
    case ZYDIS_MNEMONIC_MOVSB:
    case ZYDIS_MNEMONIC_MOVSW:
    case ZYDIS_MNEMONIC_MOVSD:
    case ZYDIS_MNEMONIC_MOVSQ:
        if (source->meta.category == ZYDIS_CATEGORY_STRINGOP) {
            out->operation = PL_X86_OPERATION_STRING;
            out->condition = 0u;
        }
        break;
    case ZYDIS_MNEMONIC_STOSB:
    case ZYDIS_MNEMONIC_STOSW:
    case ZYDIS_MNEMONIC_STOSD:
    case ZYDIS_MNEMONIC_STOSQ:
        out->operation = PL_X86_OPERATION_STRING;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_LODSB:
    case ZYDIS_MNEMONIC_LODSW:
    case ZYDIS_MNEMONIC_LODSD:
    case ZYDIS_MNEMONIC_LODSQ:
        out->operation = PL_X86_OPERATION_STRING;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_CMPSB:
    case ZYDIS_MNEMONIC_CMPSW:
    case ZYDIS_MNEMONIC_CMPSD:
    case ZYDIS_MNEMONIC_CMPSQ:
        out->operation = PL_X86_OPERATION_STRING;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_SCASB:
    case ZYDIS_MNEMONIC_SCASW:
    case ZYDIS_MNEMONIC_SCASD:
    case ZYDIS_MNEMONIC_SCASQ:
        out->operation = PL_X86_OPERATION_STRING;
        out->condition = 4u;
        break;
    case ZYDIS_MNEMONIC_PAUSE:
        out->operation = PL_X86_OPERATION_NOP;
        break;
    case ZYDIS_MNEMONIC_XADD:
        out->operation = PL_X86_OPERATION_EXCHANGE_ADD;
        break;
    case ZYDIS_MNEMONIC_CMPXCHG:
        out->operation = PL_X86_OPERATION_COMPARE_EXCHANGE;
        break;
    case ZYDIS_MNEMONIC_RORX:
        out->operation = PL_X86_OPERATION_SHIFT_NO_FLAGS;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_SHLX:
        out->operation = PL_X86_OPERATION_SHIFT_NO_FLAGS;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_SHRX:
        out->operation = PL_X86_OPERATION_SHIFT_NO_FLAGS;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_SARX:
        out->operation = PL_X86_OPERATION_SHIFT_NO_FLAGS;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_BSR:
        out->operation = PL_X86_OPERATION_BIT_SUMMARY;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_BSF:
        out->operation = PL_X86_OPERATION_BIT_SUMMARY;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_TZCNT:
        out->operation = PL_X86_OPERATION_BIT_SUMMARY;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_LZCNT:
        out->operation = PL_X86_OPERATION_BIT_SUMMARY;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_POPCNT:
        out->operation = PL_X86_OPERATION_BIT_SUMMARY;
        out->condition = 4u;
        break;
    case ZYDIS_MNEMONIC_SHLD:
        out->operation = PL_X86_OPERATION_DOUBLE_SHIFT;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_SHRD:
        out->operation = PL_X86_OPERATION_DOUBLE_SHIFT;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_ANDN:
        out->operation = PL_X86_OPERATION_AND_NOT;
        break;
    case ZYDIS_MNEMONIC_MOVBE:
        out->operation = PL_X86_OPERATION_MOVE_BYTE_SWAP;
        break;
    case ZYDIS_MNEMONIC_MOVNTI:
        out->operation = PL_X86_OPERATION_MOVE;
        break;
    case ZYDIS_MNEMONIC_RDFSBASE:
        out->operation = PL_X86_OPERATION_BASE_ACCESS;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_RDGSBASE:
        out->operation = PL_X86_OPERATION_BASE_ACCESS;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_WRFSBASE:
        out->operation = PL_X86_OPERATION_BASE_ACCESS;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_WRGSBASE:
        out->operation = PL_X86_OPERATION_BASE_ACCESS;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_CRC32:
        out->operation = PL_X86_OPERATION_CRC32;
        break;
    case ZYDIS_MNEMONIC_BZHI:
        out->operation = PL_X86_OPERATION_BZHI;
        break;
    case ZYDIS_MNEMONIC_PREFETCH:
    case ZYDIS_MNEMONIC_PREFETCHIT0:
    case ZYDIS_MNEMONIC_PREFETCHIT1:
    case ZYDIS_MNEMONIC_PREFETCHNTA:
    case ZYDIS_MNEMONIC_PREFETCHT0:
    case ZYDIS_MNEMONIC_PREFETCHT1:
    case ZYDIS_MNEMONIC_PREFETCHT2:
    case ZYDIS_MNEMONIC_PREFETCHW:
    case ZYDIS_MNEMONIC_PREFETCHWT1:
        out->operation = PL_X86_OPERATION_NOP;
        break;
    case ZYDIS_MNEMONIC_FDISI8087_NOP:
    case ZYDIS_MNEMONIC_FENI8087_NOP:
    case ZYDIS_MNEMONIC_FNOP:
    case ZYDIS_MNEMONIC_FSETPM287_NOP:
        out->operation = PL_X86_OPERATION_NOP;
        break;
    case ZYDIS_MNEMONIC_EMMS:
    case ZYDIS_MNEMONIC_FEMMS:
    case ZYDIS_MNEMONIC_CLFLUSH:
    case ZYDIS_MNEMONIC_CLFLUSHOPT:
    case ZYDIS_MNEMONIC_CLWB:
    case ZYDIS_MNEMONIC_CLDEMOTE:
    case ZYDIS_MNEMONIC_CMPXCHG8B:
    case ZYDIS_MNEMONIC_CMPXCHG16B:
    case ZYDIS_MNEMONIC_RDSEED:
    case ZYDIS_MNEMONIC_RDRAND:
    case ZYDIS_MNEMONIC_VZEROUPPER:
    case ZYDIS_MNEMONIC_MONITOR:
    case ZYDIS_MNEMONIC_MONITORX:
    case ZYDIS_MNEMONIC_MWAIT:
    case ZYDIS_MNEMONIC_MWAITX:
    case ZYDIS_MNEMONIC_INVPCID:
    case ZYDIS_MNEMONIC_PBNDKB:
    case ZYDIS_MNEMONIC_VCVTTSD2SI:
    case ZYDIS_MNEMONIC_RDPID:
    case ZYDIS_MNEMONIC_TILERELEASE:
    case ZYDIS_MNEMONIC_TPAUSE:
    case ZYDIS_MNEMONIC_XSHA256:
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    case ZYDIS_MNEMONIC_FWAIT:
    case ZYDIS_MNEMONIC_LFENCE:
    case ZYDIS_MNEMONIC_MFENCE:
    case ZYDIS_MNEMONIC_SFENCE:
    case ZYDIS_MNEMONIC_SERIALIZE:
    case ZYDIS_MNEMONIC_CPUID:
    case ZYDIS_MNEMONIC_CLAC:
    case ZYDIS_MNEMONIC_STAC:
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    case ZYDIS_MNEMONIC_ROL:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_ROR:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_RCL:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_RCR:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_SHL:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 4u;
        break;
    case ZYDIS_MNEMONIC_SHR:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 5u;
        break;
    case ZYDIS_MNEMONIC_SAR:
        out->operation = PL_X86_OPERATION_SHIFT;
        out->condition = 7u;
        break;
    case ZYDIS_MNEMONIC_CLC:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 0u;
        break;
    case ZYDIS_MNEMONIC_STC:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 1u;
        break;
    case ZYDIS_MNEMONIC_CMC:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 2u;
        break;
    case ZYDIS_MNEMONIC_CLD:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 3u;
        break;
    case ZYDIS_MNEMONIC_STD:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 4u;
        break;
    case ZYDIS_MNEMONIC_CLI:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 5u;
        out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER
                    | PL_X86_INSTRUCTION_MAY_TRAP;
        break;
    case ZYDIS_MNEMONIC_STI:
        out->operation = PL_X86_OPERATION_FLAG_CONTROL;
        out->condition = 6u;
        out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER
                    | PL_X86_INSTRUCTION_MAY_TRAP;
        break;
    case ZYDIS_MNEMONIC_XBEGIN:
        /* RTM abort status and transactional memory are machine state, not
         * an RFLAGS predicate.  Preserve both successors at the barrier ABI. */
        out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER
                    | PL_X86_INSTRUCTION_MAY_TRAP;
        break;
    case ZYDIS_MNEMONIC_NOP:
    case ZYDIS_MNEMONIC_ENDBR32:
    case ZYDIS_MNEMONIC_ENDBR64:
        out->operation = PL_X86_OPERATION_NOP;
        break;
    case ZYDIS_MNEMONIC_MOV:
        out->operation = PL_X86_OPERATION_MOVE;
        break;
    case ZYDIS_MNEMONIC_MOVZX:
        out->operation = PL_X86_OPERATION_MOVE_ZERO_EXTEND;
        break;
    case ZYDIS_MNEMONIC_MOVSX:
    case ZYDIS_MNEMONIC_MOVSXD:
        out->operation = PL_X86_OPERATION_MOVE_SIGN_EXTEND;
        break;
    case ZYDIS_MNEMONIC_LEA:
        out->operation = PL_X86_OPERATION_LOAD_ADDRESS;
        break;
    case ZYDIS_MNEMONIC_XCHG:
        out->operation = PL_X86_OPERATION_EXCHANGE;
        break;
    case ZYDIS_MNEMONIC_ADD:
        out->operation = PL_X86_OPERATION_ADD;
        break;
    case ZYDIS_MNEMONIC_ADC:
        out->operation = PL_X86_OPERATION_ADD_CARRY;
        break;
    case ZYDIS_MNEMONIC_SUB:
        out->operation = PL_X86_OPERATION_SUBTRACT;
        break;
    case ZYDIS_MNEMONIC_SBB:
        out->operation = PL_X86_OPERATION_SUBTRACT_BORROW;
        break;
    case ZYDIS_MNEMONIC_AND:
        out->operation = PL_X86_OPERATION_AND;
        break;
    case ZYDIS_MNEMONIC_OR:
        out->operation = PL_X86_OPERATION_OR;
        break;
    case ZYDIS_MNEMONIC_XOR:
        out->operation = PL_X86_OPERATION_XOR;
        break;
    case ZYDIS_MNEMONIC_CMP:
        out->operation = PL_X86_OPERATION_COMPARE;
        break;
    case ZYDIS_MNEMONIC_TEST:
        out->operation = PL_X86_OPERATION_TEST;
        break;
    case ZYDIS_MNEMONIC_INC:
        out->operation = PL_X86_OPERATION_INCREMENT;
        break;
    case ZYDIS_MNEMONIC_DEC:
        out->operation = PL_X86_OPERATION_DECREMENT;
        break;
    case ZYDIS_MNEMONIC_NEG:
        out->operation = PL_X86_OPERATION_NEGATE;
        break;
    case ZYDIS_MNEMONIC_NOT:
        out->operation = PL_X86_OPERATION_COMPLEMENT;
        break;
    case ZYDIS_MNEMONIC_MUL:
        out->operation = PL_X86_OPERATION_MULTIPLY_UNSIGNED;
        break;
    case ZYDIS_MNEMONIC_IMUL:
        out->operation = PL_X86_OPERATION_MULTIPLY_SIGNED;
        break;
    case ZYDIS_MNEMONIC_DIV:
        out->operation = PL_X86_OPERATION_DIVIDE_UNSIGNED;
        out->family = PL_X86_FAMILY_DIVIDE_UNSIGNED;
        out->trap_vector = 0u;
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
        break;
    case ZYDIS_MNEMONIC_IDIV:
        out->operation = PL_X86_OPERATION_DIVIDE_SIGNED;
        out->family = PL_X86_FAMILY_DIVIDE_SIGNED;
        out->trap_vector = 0u;
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
        break;
    case ZYDIS_MNEMONIC_HLT:
        out->flow = PL_X86_FLOW_HALT;
        out->family = PL_X86_FAMILY_HALT;
        out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    case ZYDIS_MNEMONIC_INT1:
        set_fault(out, PL_X86_DECODE_VALID, 1u);
        out->family = PL_X86_FAMILY_INTERRUPT;
        out->flags |= PL_X86_INSTRUCTION_TRAP_AFTER;
        break;
    case ZYDIS_MNEMONIC_INT3:
        set_fault(out, PL_X86_DECODE_VALID, 3u);
        out->family = PL_X86_FAMILY_INTERRUPT;
        out->flags |= PL_X86_INSTRUCTION_TRAP_AFTER;
        break;
    case ZYDIS_MNEMONIC_INTO: out->trap_vector = 4u; break;
    case ZYDIS_MNEMONIC_UD0:
    case ZYDIS_MNEMONIC_UD1:
    case ZYDIS_MNEMONIC_UD2:
        set_fault(out, PL_X86_DECODE_VALID, 6u);
        break;
    default: break;
    }
}

static int classify_scalar_vector_move(
        const ZydisDecodedInstruction *source, pl_x86_instruction *out)
{
    if (out->visible_operand_count != 2u) return 0;
    pl_u32 bits = source->mnemonic == ZYDIS_MNEMONIC_MOVSS ? 32u : 64u;
    const pl_x86_operand *target = &out->operands[0];
    const pl_x86_operand *input = &out->operands[1];
    int target_vector = target->kind == PL_X86_OPERAND_REGISTER
                     && target->value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && target->value.reg.index < 16u
                     && (target->bits == bits || target->bits == 128u);
    int source_vector = input->kind == PL_X86_OPERAND_REGISTER
                     && input->value.reg.class_id == PL_X86_REGISTER_VECTOR
                     && input->value.reg.index < 16u
                     && (input->bits == bits || input->bits == 128u);
    int target_memory = target->kind == PL_X86_OPERAND_MEMORY
                     && target->bits == bits;
    int source_memory = input->kind == PL_X86_OPERAND_MEMORY
                     && input->bits == bits;
    if (!((target_vector && (source_vector || source_memory))
            || (target_memory && source_vector)))
        return 0;
    out->machine_operation = PL_X86_MACHINE_VECTOR;
    out->machine_argument = 39u
        | ((pl_u64)(target_vector ? target->value.reg.index : 0u) << 8u)
        | ((pl_u64)(source_vector ? input->value.reg.index : 0u) << 16u)
        | ((pl_u64)source_memory << 24u)
        | ((pl_u64)target_memory << 25u)
        | ((pl_u64)(bits == 64u) << 32u);
    return 1;
}

static int scalar_vector_register(const pl_x86_operand *operand)
{
    return operand->kind == PL_X86_OPERAND_REGISTER
        && operand->value.reg.class_id == PL_X86_REGISTER_VECTOR
        && operand->value.reg.index < 16u;
}

static int scalar_general_register(const pl_x86_operand *operand)
{
    return operand->kind == PL_X86_OPERAND_REGISTER
        && operand->value.reg.class_id == PL_X86_REGISTER_GPR
        && operand->value.reg.index < 16u;
}

static int classify_scalar_float(
        const ZydisDecodedInstruction *source, pl_x86_instruction *out)
{
    pl_u32 operation;
    switch (source->mnemonic) {
    case ZYDIS_MNEMONIC_ADDSS:
    case ZYDIS_MNEMONIC_ADDSD:
        operation = PL_X86_SCALAR_FLOAT_ADD;
        break;
    case ZYDIS_MNEMONIC_MULSS:
    case ZYDIS_MNEMONIC_MULSD:
        operation = PL_X86_SCALAR_FLOAT_MULTIPLY;
        break;
    case ZYDIS_MNEMONIC_SUBSS:
    case ZYDIS_MNEMONIC_SUBSD:
        operation = PL_X86_SCALAR_FLOAT_SUBTRACT;
        break;
    case ZYDIS_MNEMONIC_DIVSS:
    case ZYDIS_MNEMONIC_DIVSD:
        operation = PL_X86_SCALAR_FLOAT_DIVIDE;
        break;
    case ZYDIS_MNEMONIC_MINSS:
    case ZYDIS_MNEMONIC_MINSD:
        operation = PL_X86_SCALAR_FLOAT_MINIMUM;
        break;
    case ZYDIS_MNEMONIC_MAXSS:
    case ZYDIS_MNEMONIC_MAXSD:
        operation = PL_X86_SCALAR_FLOAT_MAXIMUM;
        break;
    case ZYDIS_MNEMONIC_COMISS:
    case ZYDIS_MNEMONIC_COMISD:
        operation = PL_X86_SCALAR_FLOAT_COMPARE_ORDERED;
        break;
    case ZYDIS_MNEMONIC_UCOMISS:
    case ZYDIS_MNEMONIC_UCOMISD:
        operation = PL_X86_SCALAR_FLOAT_COMPARE_UNORDERED;
        break;
    case ZYDIS_MNEMONIC_CVTSI2SS:
    case ZYDIS_MNEMONIC_CVTSI2SD:
        operation = PL_X86_SCALAR_FLOAT_INTEGER_TO_FLOAT;
        break;
    case ZYDIS_MNEMONIC_CVTTSS2SI:
    case ZYDIS_MNEMONIC_CVTTSD2SI:
        operation = PL_X86_SCALAR_FLOAT_TO_INTEGER_TRUNCATE;
        break;
    case ZYDIS_MNEMONIC_CVTSS2SD:
        operation = PL_X86_SCALAR_FLOAT_WIDEN;
        break;
    case ZYDIS_MNEMONIC_CVTSD2SS:
        operation = PL_X86_SCALAR_FLOAT_NARROW;
        break;
    case ZYDIS_MNEMONIC_RCPSS:
        operation = PL_X86_SCALAR_FLOAT_RECIPROCAL;
        break;
    case ZYDIS_MNEMONIC_SQRTSS:
    case ZYDIS_MNEMONIC_SQRTSD:
        operation = PL_X86_SCALAR_FLOAT_SQUARE_ROOT;
        break;
    case ZYDIS_MNEMONIC_CMPSS:
    case ZYDIS_MNEMONIC_CMPSD:
        if (source->meta.category == ZYDIS_CATEGORY_STRINGOP) return 0;
        operation = PL_X86_SCALAR_FLOAT_PREDICATE;
        break;
    default:
        return 0;
    }

    pl_u32 expected = operation == PL_X86_SCALAR_FLOAT_PREDICATE ? 3u : 2u;
    if (out->visible_operand_count != expected) return 0;
    const pl_x86_operand *target = &out->operands[0];
    const pl_x86_operand *input = &out->operands[1];
    int target_vector = scalar_vector_register(target);
    int target_gpr = scalar_general_register(target);
    int source_vector = scalar_vector_register(input);
    int source_gpr = scalar_general_register(input);
    int source_memory = input->kind == PL_X86_OPERAND_MEMORY;
    int valid = 0;
    switch (operation) {
    case PL_X86_SCALAR_FLOAT_ADD:
    case PL_X86_SCALAR_FLOAT_MULTIPLY:
    case PL_X86_SCALAR_FLOAT_SUBTRACT:
    case PL_X86_SCALAR_FLOAT_DIVIDE:
    case PL_X86_SCALAR_FLOAT_MINIMUM:
    case PL_X86_SCALAR_FLOAT_MAXIMUM:
    case PL_X86_SCALAR_FLOAT_COMPARE_ORDERED:
    case PL_X86_SCALAR_FLOAT_COMPARE_UNORDERED:
    case PL_X86_SCALAR_FLOAT_RECIPROCAL:
    case PL_X86_SCALAR_FLOAT_SQUARE_ROOT:
        valid = target_vector && (source_vector || source_memory)
             && target->bits == input->bits
             && (target->bits == 32u || target->bits == 64u);
        break;
    case PL_X86_SCALAR_FLOAT_INTEGER_TO_FLOAT:
        valid = target_vector && (source_gpr || source_memory)
             && (target->bits == 32u || target->bits == 64u)
             && (input->bits == 32u || input->bits == 64u);
        break;
    case PL_X86_SCALAR_FLOAT_TO_INTEGER_TRUNCATE:
        valid = target_gpr && (source_vector || source_memory)
             && (target->bits == 32u || target->bits == 64u)
             && (input->bits == 32u || input->bits == 64u);
        break;
    case PL_X86_SCALAR_FLOAT_WIDEN:
        valid = target_vector && target->bits == 64u
             && (source_vector || source_memory) && input->bits == 32u;
        break;
    case PL_X86_SCALAR_FLOAT_NARROW:
        valid = target_vector && target->bits == 32u
             && (source_vector || source_memory) && input->bits == 64u;
        break;
    case PL_X86_SCALAR_FLOAT_PREDICATE:
        valid = target_vector && (source_vector || source_memory)
             && target->bits == input->bits
             && (target->bits == 32u || target->bits == 64u)
             && out->operands[2].kind == PL_X86_OPERAND_IMMEDIATE
             && out->operands[2].bits == 8u;
        break;
    default:
        break;
    }
    if (!valid) return 0;

    pl_u64 immediate = operation == PL_X86_SCALAR_FLOAT_PREDICATE
                     ? out->operands[2].value.immediate & 7u : 0u;
    out->machine_operation = PL_X86_MACHINE_VECTOR;
    out->machine_argument = PL_X86_VECTOR_SCALAR_FLOAT
        | ((pl_u64)(target_vector || target_gpr
                    ? target->value.reg.index : 0u)
           << PL_X86_SCALAR_FLOAT_TARGET_SHIFT)
        | ((pl_u64)(source_vector || source_gpr
                    ? input->value.reg.index : 0u)
           << PL_X86_SCALAR_FLOAT_SOURCE_SHIFT)
        | (source_memory ? PL_X86_SCALAR_FLOAT_SOURCE_MEMORY : 0u)
        | (target_gpr ? PL_X86_SCALAR_FLOAT_TARGET_GPR : 0u)
        | (source_gpr ? PL_X86_SCALAR_FLOAT_SOURCE_GPR : 0u)
        | ((pl_u64)operation << PL_X86_SCALAR_FLOAT_OPERATION_SHIFT)
        | ((pl_u64)(target->bits / 8u)
           << PL_X86_SCALAR_FLOAT_TARGET_BYTES_SHIFT)
        | ((pl_u64)(input->bits / 8u)
           << PL_X86_SCALAR_FLOAT_SOURCE_BYTES_SHIFT)
        | (immediate << PL_X86_SCALAR_FLOAT_IMMEDIATE_SHIFT);
    out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                | PL_X86_INSTRUCTION_PRECISE_CUT
                | PL_X86_INSTRUCTION_BARRIER;
    return 1;
}

static void classify_machine_operation(
        const ZydisDecodedInstruction *source, pl_x86_instruction *out)
{
    switch (source->mnemonic) {
    case ZYDIS_MNEMONIC_ADDSS:
    case ZYDIS_MNEMONIC_ADDSD:
    case ZYDIS_MNEMONIC_MULSS:
    case ZYDIS_MNEMONIC_MULSD:
    case ZYDIS_MNEMONIC_SUBSS:
    case ZYDIS_MNEMONIC_SUBSD:
    case ZYDIS_MNEMONIC_DIVSS:
    case ZYDIS_MNEMONIC_DIVSD:
    case ZYDIS_MNEMONIC_MINSS:
    case ZYDIS_MNEMONIC_MINSD:
    case ZYDIS_MNEMONIC_MAXSS:
    case ZYDIS_MNEMONIC_MAXSD:
    case ZYDIS_MNEMONIC_COMISD:
    case ZYDIS_MNEMONIC_UCOMISD:
    case ZYDIS_MNEMONIC_CVTSI2SS:
    case ZYDIS_MNEMONIC_CVTSI2SD:
    case ZYDIS_MNEMONIC_CVTTSS2SI:
    case ZYDIS_MNEMONIC_CVTTSD2SI:
    case ZYDIS_MNEMONIC_CVTSS2SD:
    case ZYDIS_MNEMONIC_CVTSD2SS:
    case ZYDIS_MNEMONIC_RCPSS:
    case ZYDIS_MNEMONIC_SQRTSS:
    case ZYDIS_MNEMONIC_SQRTSD:
    case ZYDIS_MNEMONIC_CMPSS:
        (void)classify_scalar_float(source, out);
        break;
    case ZYDIS_MNEMONIC_WRMSR:
        out->machine_operation = PL_X86_MACHINE_WRITE_MSR;
        break;
    case ZYDIS_MNEMONIC_RDMSR:
        out->machine_operation = PL_X86_MACHINE_READ_MSR;
        break;
    case ZYDIS_MNEMONIC_CPUID:
        out->machine_operation = PL_X86_MACHINE_CPUID;
        break;
    case ZYDIS_MNEMONIC_CLI:
        out->machine_operation = PL_X86_MACHINE_INTERRUPT_FLAG;
        out->machine_argument = 0u;
        break;
    case ZYDIS_MNEMONIC_STI:
        out->machine_operation = PL_X86_MACHINE_INTERRUPT_FLAG;
        out->machine_argument = 1u;
        break;
    case ZYDIS_MNEMONIC_SWAPGS:
        out->machine_operation = PL_X86_MACHINE_SWAP_GS;
        break;
    case ZYDIS_MNEMONIC_HLT:
        out->machine_operation = PL_X86_MACHINE_HALT;
        break;
    case ZYDIS_MNEMONIC_MOVSB:
    case ZYDIS_MNEMONIC_MOVSW:
    case ZYDIS_MNEMONIC_MOVSD:
    case ZYDIS_MNEMONIC_MOVSQ:
    case ZYDIS_MNEMONIC_LODSB:
    case ZYDIS_MNEMONIC_LODSW:
    case ZYDIS_MNEMONIC_LODSD:
    case ZYDIS_MNEMONIC_LODSQ:
    case ZYDIS_MNEMONIC_CMPSB:
    case ZYDIS_MNEMONIC_CMPSW:
    case ZYDIS_MNEMONIC_CMPSD:
    case ZYDIS_MNEMONIC_CMPSQ:
    case ZYDIS_MNEMONIC_SCASB:
    case ZYDIS_MNEMONIC_SCASW:
    case ZYDIS_MNEMONIC_SCASD:
    case ZYDIS_MNEMONIC_SCASQ:
        if (source->meta.category != ZYDIS_CATEGORY_STRINGOP
                && (source->mnemonic == ZYDIS_MNEMONIC_MOVSD
                    || source->mnemonic == ZYDIS_MNEMONIC_CMPSD)) {
            if (source->mnemonic == ZYDIS_MNEMONIC_MOVSD)
                (void)classify_scalar_vector_move(source, out);
            else
                (void)classify_scalar_float(source, out);
        } else if ((out->flags & PL_X86_INSTRUCTION_REPEATED)
                && (out->condition == 0u || out->condition == 2u
                    || out->condition == 3u || out->condition == 4u)
                && (out->operand_width == 8u
                    || out->operand_width == 16u
                    || out->operand_width == 32u
                    || out->operand_width == 64u)
                && (out->address_width == 32u
                    || out->address_width == 64u)) {
            pl_u32 segment = 0u;
            int source_operand = out->condition == 4u;
            if (!source_operand) {
                segment = 3u;          /* implicit DS */
                for (pl_u32 index = 0u;
                        index < out->operand_count; ++index) {
                    const pl_x86_operand *operand = &out->operands[index];
                    if (operand->kind != PL_X86_OPERAND_MEMORY
                            || operand->value.memory.base.class_id
                               != PL_X86_REGISTER_GPR
                            || operand->value.memory.base.index != 6u)
                        continue;
                    source_operand = 1;
                    if (operand->value.memory.segment.class_id
                            == PL_X86_REGISTER_SEGMENT)
                        segment = operand->value.memory.segment.index;
                    break;
                }
            }
            if (source_operand && segment <= 5u) {
                pl_u32 not_equal = (out->condition == 3u
                                    || out->condition == 4u)
                    && !!(out->flags
                          & PL_X86_INSTRUCTION_REPEAT_WHILE_NOT_EQUAL);
                out->machine_operation = PL_X86_MACHINE_STRING;
                out->machine_argument = out->operand_width / 8u
                    | ((pl_u64)out->address_width << 8u)
                    | ((pl_u64)segment << 16u)
                    | ((pl_u64)out->condition << 24u)
                    | ((pl_u64)not_equal << 27u);
            }
        }
        break;
    case ZYDIS_MNEMONIC_MOVSS:
        (void)classify_scalar_vector_move(source, out);
        break;
    case ZYDIS_MNEMONIC_FNINIT:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = PL_X86_X87_INITIALIZE;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FNCLEX:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = PL_X86_X87_CLEAR_EXCEPTIONS;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FCOS:
    case ZYDIS_MNEMONIC_FSIN:
    case ZYDIS_MNEMONIC_FSINCOS:
    case ZYDIS_MNEMONIC_FPTAN:
        if (!out->visible_operand_count) {
            pl_u32 variant = source->mnemonic == ZYDIS_MNEMONIC_FCOS ? 0u
                           : source->mnemonic == ZYDIS_MNEMONIC_FSIN ? 1u
                           : source->mnemonic == ZYDIS_MNEMONIC_FSINCOS
                             ? 2u : 3u;
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 48u | ((pl_u64)fop << 16u)
                                  | ((pl_u64)variant << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_F2XM1:
    case ZYDIS_MNEMONIC_FYL2X:
    case ZYDIS_MNEMONIC_FYL2XP1:
    case ZYDIS_MNEMONIC_FPATAN:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 variant = source->mnemonic == ZYDIS_MNEMONIC_F2XM1 ? 0u
                           : source->mnemonic == ZYDIS_MNEMONIC_FYL2X ? 1u
                           : source->mnemonic == ZYDIS_MNEMONIC_FYL2XP1
                             ? 2u : 3u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 58u | ((pl_u64)fop << 16u)
                                  | ((pl_u64)variant << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FRNDINT:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 49u | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FSCALE:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 50u | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FSQRT:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 52u | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FPREM:
    case ZYDIS_MNEMONIC_FPREM1:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 nearest = source->mnemonic == ZYDIS_MNEMONIC_FPREM1;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 53u | ((pl_u64)fop << 16u)
                                  | ((pl_u64)nearest << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FCHS:
    case ZYDIS_MNEMONIC_FABS:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 absolute = source->mnemonic == ZYDIS_MNEMONIC_FABS;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 54u | ((pl_u64)fop << 16u)
                                  | ((pl_u64)absolute << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTDQ2PS:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 16u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTDQ2PD:
    case ZYDIS_MNEMONIC_CVTTPD2DQ:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits
                        == (source->mnemonic == ZYDIS_MNEMONIC_CVTDQ2PD
                            ? 64u : 128u)
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits
                           == (source->mnemonic
                               == ZYDIS_MNEMONIC_CVTDQ2PD
                               ? 64u : 128u)))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 operation = source->mnemonic == ZYDIS_MNEMONIC_CVTDQ2PD
                ? PL_X86_PACKED_CONVERT_SIGNED_DWORD_TO_FLOAT64
                : PL_X86_PACKED_CONVERT_FLOAT64_TO_SIGNED_DWORD_TRUNCATE;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = PL_X86_VECTOR_PACKED_CONVERT
                | ((pl_u64)out->operands[0].value.reg.index
                   << PL_X86_VECTOR_TARGET_SHIFT)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index)
                   << PL_X86_VECTOR_SOURCE_SHIFT)
                | ((pl_u64)memory << 24u)
                | ((pl_u64)operation << PL_X86_VECTOR_IMMEDIATE_SHIFT);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTPI2PS:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 64u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_MMX
                     && out->operands[1].bits == 64u
                     && out->operands[1].value.reg.index < 8u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 64u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 30u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTPS2PD:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 64u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 64u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 31u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTTPD2PI:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_MMX
                && out->operands[0].bits == 64u
                && out->operands[0].value.reg.index < 8u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 32u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_MASKMOVQ:
    case ZYDIS_MNEMONIC_MASKMOVDQU:
        if (out->visible_operand_count == 2u
                && (out->address_width == 32u
                    || out->address_width == 64u)) {
            pl_u32 vector = source->mnemonic == ZYDIS_MNEMONIC_MASKMOVDQU;
            pl_u32 register_class_id = vector ? PL_X86_REGISTER_VECTOR
                                              : PL_X86_REGISTER_MMX;
            pl_u32 bits = vector ? 128u : 64u;
            pl_u32 registers = vector ? 16u : 8u;
            if (out->operands[0].kind != PL_X86_OPERAND_REGISTER
                    || out->operands[0].value.reg.class_id
                       != register_class_id
                    || out->operands[0].bits != bits
                    || out->operands[0].value.reg.index >= registers
                    || out->operands[1].kind != PL_X86_OPERAND_REGISTER
                    || out->operands[1].value.reg.class_id
                       != register_class_id
                    || out->operands[1].bits != bits
                    || out->operands[1].value.reg.index >= registers)
                break;
            pl_u32 segment = 3u;       /* implicit DS */
            for (pl_u32 index = out->visible_operand_count;
                    index < out->operand_count; ++index)
                if (out->operands[index].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[index].value.memory.segment.class_id
                           == PL_X86_REGISTER_SEGMENT) {
                    segment = out->operands[index].value.memory.segment.index;
                    break;
                }
            if (segment > 5u) break;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 33u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)out->operands[1].value.reg.index << 16u)
                | ((pl_u64)(segment
                    | ((pl_u32)(out->address_width == 64u) << 3u)
                    | (vector << 4u)) << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTTPS2PI:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_MMX
                && out->operands[0].bits == 64u
                && out->operands[0].value.reg.index < 8u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 64u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 64u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 17u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CVTPS2PI:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_MMX
                && out->operands[0].bits == 64u
                && out->operands[0].value.reg.index < 8u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 64u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 64u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 21u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_SQRTPS:
    case ZYDIS_MNEMONIC_RCPPS:
    case ZYDIS_MNEMONIC_RSQRTPS:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_SQRTPS ? 18u
                        : source->mnemonic == ZYDIS_MNEMONIC_RCPPS ? 37u
                        : 38u;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = kind
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CMPPS:
        if (out->visible_operand_count == 3u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))
                && out->operands[2].kind == PL_X86_OPERAND_IMMEDIATE
                && out->operands[2].bits == 8u) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 19u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u)
                | ((out->operands[2].value.immediate & 7u) << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_ADDPS:
    case ZYDIS_MNEMONIC_MULPS:
    case ZYDIS_MNEMONIC_SUBPS:
    case ZYDIS_MNEMONIC_DIVPS:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_ADDPS ? 20u
                        : source->mnemonic == ZYDIS_MNEMONIC_MULPS ? 34u
                        : source->mnemonic == ZYDIS_MNEMONIC_SUBPS ? 35u
                        : 36u;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = kind
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_ADDPD:
    case ZYDIS_MNEMONIC_MULPD:
    case ZYDIS_MNEMONIC_SUBPD:
    case ZYDIS_MNEMONIC_DIVPD:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 operation = source->mnemonic == ZYDIS_MNEMONIC_ADDPD
                             ? PL_X86_PACKED_FLOAT_ADD
                             : source->mnemonic == ZYDIS_MNEMONIC_MULPD
                             ? PL_X86_PACKED_FLOAT_MULTIPLY
                             : source->mnemonic == ZYDIS_MNEMONIC_SUBPD
                             ? PL_X86_PACKED_FLOAT_SUBTRACT
                             : PL_X86_PACKED_FLOAT_DIVIDE;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = PL_X86_VECTOR_PACKED_FLOAT64
                | ((pl_u64)out->operands[0].value.reg.index
                   << PL_X86_VECTOR_TARGET_SHIFT)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index)
                   << PL_X86_VECTOR_SOURCE_SHIFT)
                | ((pl_u64)memory << 24u)
                | ((pl_u64)operation
                   << PL_X86_PACKED_FLOAT_OPERATION_SHIFT);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_MINPS:
    case ZYDIS_MNEMONIC_MAXPS:
    case ZYDIS_MNEMONIC_MINPD:
    case ZYDIS_MNEMONIC_MAXPD:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_VECTOR
                && out->operands[0].bits == 128u
                && out->operands[0].value.reg.index < 16u
                && ((out->operands[1].kind == PL_X86_OPERAND_REGISTER
                     && out->operands[1].value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && out->operands[1].bits == 128u
                     && out->operands[1].value.reg.index < 16u)
                    || (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[1].bits == 128u))) {
            int memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            int maximum = source->mnemonic == ZYDIS_MNEMONIC_MAXPS
                       || source->mnemonic == ZYDIS_MNEMONIC_MAXPD;
            int binary64 = source->mnemonic == ZYDIS_MNEMONIC_MINPD
                        || source->mnemonic == ZYDIS_MNEMONIC_MAXPD;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 26u
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)memory << 24u)
                | ((pl_u64)(maximum | (binary64 << 1u)) << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_UCOMISS:
    case ZYDIS_MNEMONIC_COMISS:
        (void)classify_scalar_float(source, out);
        break;
    case ZYDIS_MNEMONIC_FXSAVE:
    case ZYDIS_MNEMONIC_FXSAVE64:
    case ZYDIS_MNEMONIC_FXRSTOR:
    case ZYDIS_MNEMONIC_FXRSTOR64:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && out->operands[0].bits == 4096u) {
            int restore = source->mnemonic == ZYDIS_MNEMONIC_FXRSTOR
                       || source->mnemonic == ZYDIS_MNEMONIC_FXRSTOR64;
            int wide = source->mnemonic == ZYDIS_MNEMONIC_FXSAVE64
                    || source->mnemonic == ZYDIS_MNEMONIC_FXRSTOR64;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = PL_X86_X87_STATE_IMAGE | ((pl_u64)restore << 40u)
                                  | ((pl_u64)wide << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_INVLPG:
        out->machine_operation = PL_X86_MACHINE_INVALIDATE_PAGE;
        break;
    case ZYDIS_MNEMONIC_SYSCALL:
        out->machine_operation = PL_X86_MACHINE_SYSTEM_TRANSFER;
        out->machine_argument = 0u;
        break;
    case ZYDIS_MNEMONIC_SYSRET:
        out->machine_operation = PL_X86_MACHINE_SYSTEM_TRANSFER;
        out->machine_argument = 1u;
        break;
    case ZYDIS_MNEMONIC_SYSENTER:
        out->machine_operation = PL_X86_MACHINE_SYSTEM_TRANSFER;
        out->machine_argument = 2u;
        break;
    case ZYDIS_MNEMONIC_SYSEXIT:
        out->machine_operation = PL_X86_MACHINE_SYSTEM_TRANSFER;
        out->machine_argument = source->operand_width == 64u ? 4u : 3u;
        break;
    case ZYDIS_MNEMONIC_IRET:
    case ZYDIS_MNEMONIC_IRETD:
    case ZYDIS_MNEMONIC_IRETQ:
        out->machine_operation = PL_X86_MACHINE_INTERRUPT_RETURN;
        out->machine_argument = source->operand_width;
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    case ZYDIS_MNEMONIC_INT:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_IMMEDIATE
                && out->operands[0].value.immediate <= 0xffu) {
            out->machine_operation = PL_X86_MACHINE_SOFTWARE_INTERRUPT;
            out->machine_argument = out->operands[0].value.immediate;
        }
        break;
    case ZYDIS_MNEMONIC_INT3:
        out->machine_operation = PL_X86_MACHINE_SOFTWARE_INTERRUPT;
        out->machine_argument = 3u;
        break;
    case ZYDIS_MNEMONIC_FWAIT:
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 0u;
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    case ZYDIS_MNEMONIC_FILD:
    case ZYDIS_MNEMONIC_FIST:
    case ZYDIS_MNEMONIC_FISTP:
    case ZYDIS_MNEMONIC_FISTTP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)) {
            pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_FILD ? 1u
                        : source->mnemonic == ZYDIS_MNEMONIC_FISTTP ? 2u
                        : source->mnemonic == ZYDIS_MNEMONIC_FISTP ? 3u : 4u;
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                |((pl_u32)source->raw.modrm.mod<<6u)|((pl_u32)source->raw.modrm.reg<<3u)|source->raw.modrm.rm;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = kind
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FBLD:
    case ZYDIS_MNEMONIC_FBSTP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && out->operands[0].bits == 80u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_FBLD ? 27u : 28u)
                | (10ull << 8u) | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FNSTCW:
    case ZYDIS_MNEMONIC_FLDCW:
    case ZYDIS_MNEMONIC_FNSTENV:
    case ZYDIS_MNEMONIC_FLDENV:
    case ZYDIS_MNEMONIC_FNSAVE:
    case ZYDIS_MNEMONIC_FRSTOR:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY) {
            pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_FNSTCW ? PL_X86_X87_STORE_CONTROL_WORD
                        : source->mnemonic == ZYDIS_MNEMONIC_FLDCW ? 30u
                        : source->mnemonic == ZYDIS_MNEMONIC_FNSTENV ? 32u
                        : source->mnemonic == ZYDIS_MNEMONIC_FLDENV ? 33u
                        : source->mnemonic == ZYDIS_MNEMONIC_FNSAVE ? 34u : 35u;
            pl_u32 width = out->operands[0].bits / 8u;
            int valid_width = (kind == 29u || kind == 30u) ? width == 2u
                            : (kind == 32u || kind == 33u)
                            ? (width == 14u || width == 28u)
                            : (width == 94u || width == 108u);
            if (!valid_width) break;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = kind | ((pl_u64)width << 8u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FNSTSW:
        if (out->visible_operand_count == 1u
                && ((out->operands[0].kind == PL_X86_OPERAND_MEMORY
                     && out->operands[0].bits == 16u)
                    || (out->operands[0].kind == PL_X86_OPERAND_REGISTER
                        && out->operands[0].value.reg.class_id
                           == PL_X86_REGISTER_GPR
                        && out->operands[0].value.reg.index == 0u
                        && out->operands[0].bits == 16u))) {
            pl_u32 width = out->operands[0].kind == PL_X86_OPERAND_MEMORY
                         ? 2u : 0u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = PL_X86_X87_STORE_STATUS_WORD | ((pl_u64)width << 8u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FCMOVB:
    case ZYDIS_MNEMONIC_FCMOVE:
    case ZYDIS_MNEMONIC_FCMOVBE:
    case ZYDIS_MNEMONIC_FCMOVU:
    case ZYDIS_MNEMONIC_FCMOVNB:
    case ZYDIS_MNEMONIC_FCMOVNE:
    case ZYDIS_MNEMONIC_FCMOVNBE:
    case ZYDIS_MNEMONIC_FCMOVNU:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index == 0u
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[1].value.reg.index < 8u) {
            pl_u32 condition = source->mnemonic == ZYDIS_MNEMONIC_FCMOVB ? 2u
                             : source->mnemonic == ZYDIS_MNEMONIC_FCMOVE ? 4u
                             : source->mnemonic == ZYDIS_MNEMONIC_FCMOVBE ? 6u
                             : source->mnemonic == ZYDIS_MNEMONIC_FCMOVU ? 10u
                             : source->mnemonic == ZYDIS_MNEMONIC_FCMOVNB ? 3u
                             : source->mnemonic == ZYDIS_MNEMONIC_FCMOVNE ? 5u
                             : source->mnemonic == ZYDIS_MNEMONIC_FCMOVNBE ? 7u
                             : 11u;
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 36u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[1].value.reg.index << 32u)
                | ((pl_u64)condition << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FUCOMI:
    case ZYDIS_MNEMONIC_FUCOMIP:
    case ZYDIS_MNEMONIC_FCOMI:
    case ZYDIS_MNEMONIC_FCOMIP:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index == 0u
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[1].value.reg.index < 8u) {
            pl_u32 pop = source->mnemonic == ZYDIS_MNEMONIC_FUCOMIP
                      || source->mnemonic == ZYDIS_MNEMONIC_FCOMIP;
            pl_u32 quiet = source->mnemonic == ZYDIS_MNEMONIC_FUCOMI
                        || source->mnemonic == ZYDIS_MNEMONIC_FUCOMIP;
            pl_u32 kind = quiet ? (pop ? 5u : 6u)
                                  : (pop ? 19u : 20u);
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                | ((pl_u32)source->raw.modrm.mod<<6u)|((pl_u32)source->raw.modrm.reg<<3u)|source->raw.modrm.rm;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = kind
                | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[1].value.reg.index << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FCOMPP:
    case ZYDIS_MNEMONIC_FUCOMPP:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                       | ((pl_u32)source->raw.modrm.mod << 6u)
                       | ((pl_u32)source->raw.modrm.reg << 3u) | source->raw.modrm.rm;
            pl_u32 quiet = source->mnemonic == ZYDIS_MNEMONIC_FUCOMPP;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 11u | ((pl_u64)fop << 16u)
                | (1ull << 32u) | ((pl_u64)(1u | (quiet << 1u)) << 36u)
                | (1ull << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FTST:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                       | ((pl_u32)source->raw.modrm.mod << 6u)
                       | ((pl_u32)source->raw.modrm.reg << 3u) | source->raw.modrm.rm;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 11u | ((pl_u64)fop << 16u)
                | (1ull << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FXAM:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 56u | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FXTRACT:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 57u | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FLD1:
    case ZYDIS_MNEMONIC_FLDL2T:
    case ZYDIS_MNEMONIC_FLDL2E:
    case ZYDIS_MNEMONIC_FLDPI:
    case ZYDIS_MNEMONIC_FLDLG2:
    case ZYDIS_MNEMONIC_FLDLN2:
    case ZYDIS_MNEMONIC_FLDZ:
        if (!out->visible_operand_count) {
            pl_u32 constant = source->mnemonic == ZYDIS_MNEMONIC_FLD1 ? 0u
                            : source->mnemonic == ZYDIS_MNEMONIC_FLDL2T ? 1u
                            : source->mnemonic == ZYDIS_MNEMONIC_FLDL2E ? 2u
                            : source->mnemonic == ZYDIS_MNEMONIC_FLDPI ? 3u
                            : source->mnemonic == ZYDIS_MNEMONIC_FLDLG2 ? 4u
                            : source->mnemonic == ZYDIS_MNEMONIC_FLDLN2 ? 5u
                            : 6u;
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 42u | ((pl_u64)fop << 16u)
                | ((pl_u64)constant << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FINCSTP:
    case ZYDIS_MNEMONIC_FDECSTP:
        if (!out->visible_operand_count) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 43u | ((pl_u64)fop << 16u)
                | ((pl_u64)(source->mnemonic == ZYDIS_MNEMONIC_FINCSTP)
                   << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FIMUL:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 7u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FADD:
    case ZYDIS_MNEMONIC_FADDP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && source->mnemonic == ZYDIS_MNEMONIC_FADD) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 8u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[1].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                |((pl_u32)source->raw.modrm.mod<<6u)|((pl_u32)source->raw.modrm.reg<<3u)|source->raw.modrm.rm;
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FADDP;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 8u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[1].value.reg.index << 32u)
                | ((pl_u64)out->operands[0].value.reg.index << 36u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FSUB:
    case ZYDIS_MNEMONIC_FSUBR:
    case ZYDIS_MNEMONIC_FSUBP:
    case ZYDIS_MNEMONIC_FSUBRP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && (source->mnemonic == ZYDIS_MNEMONIC_FSUB
                    || source->mnemonic == ZYDIS_MNEMONIC_FSUBR)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FSUBR;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 13u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[1].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                |((pl_u32)source->raw.modrm.mod<<6u)|((pl_u32)source->raw.modrm.reg<<3u)|source->raw.modrm.rm;
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FSUBR
                          || source->mnemonic == ZYDIS_MNEMONIC_FSUBRP;
            if (source->mnemonic == ZYDIS_MNEMONIC_FSUBP
                    || source->mnemonic == ZYDIS_MNEMONIC_FSUBRP)
                options |= 2u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 13u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[1].value.reg.index << 32u)
                | ((pl_u64)out->operands[0].value.reg.index << 36u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FDIV:
    case ZYDIS_MNEMONIC_FDIVR:
    case ZYDIS_MNEMONIC_FDIVP:
    case ZYDIS_MNEMONIC_FDIVRP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && (source->mnemonic == ZYDIS_MNEMONIC_FDIV
                    || source->mnemonic == ZYDIS_MNEMONIC_FDIVR)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FDIVR;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 15u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[1].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FDIVR
                          || source->mnemonic == ZYDIS_MNEMONIC_FDIVRP;
            if (source->mnemonic == ZYDIS_MNEMONIC_FDIVP
                    || source->mnemonic == ZYDIS_MNEMONIC_FDIVRP)
                options |= 2u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 15u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[1].value.reg.index << 32u)
                | ((pl_u64)out->operands[0].value.reg.index << 36u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FIDIV:
    case ZYDIS_MNEMONIC_FIDIVR:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FIDIVR;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 16u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)options << 36u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FMUL:
    case ZYDIS_MNEMONIC_FMULP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && source->mnemonic == ZYDIS_MNEMONIC_FMUL) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 9u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[1].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FMULP;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 9u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[1].value.reg.index << 32u)
                | ((pl_u64)out->operands[0].value.reg.index << 36u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FLD:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u
                    || out->operands[0].bits == 80u)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 10u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 10u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[0].value.reg.index << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FXCH: {
        const pl_x86_operand *other = 0;
        if (out->visible_operand_count == 1u) {
            other = &out->operands[0];
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index == 0u) {
            other = &out->operands[1];
        }
        if (other && other->kind == PL_X86_OPERAND_REGISTER
                && other->value.reg.class_id == PL_X86_REGISTER_X87
                && other->value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 21u | ((pl_u64)fop << 16u)
                | ((pl_u64)other->value.reg.index << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    }
    case ZYDIS_MNEMONIC_FFREE:
    case ZYDIS_MNEMONIC_FFREEP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FFREEP;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 22u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[0].value.reg.index << 32u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FST:
    case ZYDIS_MNEMONIC_FSTP:
    case ZYDIS_MNEMONIC_FSTPNCE:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u
                    || out->operands[0].bits == 80u)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic != ZYDIS_MNEMONIC_FST;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 14u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_X87
                && out->operands[0].value.reg.index < 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic != ZYDIS_MNEMONIC_FST;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 14u | ((pl_u64)fop << 16u)
                | ((pl_u64)out->operands[0].value.reg.index << 36u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FCOM:
    case ZYDIS_MNEMONIC_FCOMP:
    case ZYDIS_MNEMONIC_FUCOM:
    case ZYDIS_MNEMONIC_FUCOMP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && (source->mnemonic == ZYDIS_MNEMONIC_FCOM
                    || source->mnemonic == ZYDIS_MNEMONIC_FCOMP)) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                       | ((pl_u32)source->raw.modrm.mod << 6u)
                       | ((pl_u32)source->raw.modrm.reg << 3u) | source->raw.modrm.rm;
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FCOMP;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 11u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)options << 36u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else {
            const pl_x86_operand *other = 0;
            if (out->visible_operand_count == 1u) {
                other = &out->operands[0];
            } else if (out->visible_operand_count == 2u
                    && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                    && out->operands[0].value.reg.class_id
                       == PL_X86_REGISTER_X87
                    && out->operands[0].value.reg.index == 0u) {
                other = &out->operands[1];
            }
            if (!other || other->kind != PL_X86_OPERAND_REGISTER
                    || other->value.reg.class_id != PL_X86_REGISTER_X87
                    || other->value.reg.index >= 8u) break;
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                       | ((pl_u32)source->raw.modrm.mod << 6u)
                       | ((pl_u32)source->raw.modrm.reg << 3u) | source->raw.modrm.rm;
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FCOMP
                          || source->mnemonic == ZYDIS_MNEMONIC_FUCOMP;
            if (source->mnemonic == ZYDIS_MNEMONIC_FUCOM
                    || source->mnemonic == ZYDIS_MNEMONIC_FUCOMP)
                options |= 2u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 11u | ((pl_u64)fop << 16u)
                | ((pl_u64)other->value.reg.index << 32u)
                | ((pl_u64)options << 36u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FICOM:
    case ZYDIS_MNEMONIC_FICOMP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u)) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                       | ((pl_u32)source->raw.modrm.mod << 6u)
                       | ((pl_u32)source->raw.modrm.reg << 3u) | source->raw.modrm.rm;
            out->machine_operation = PL_X86_MACHINE_X87;
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FICOMP
                           ? 5u : 4u;
            out->machine_argument = 11u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u) | ((pl_u64)options << 36u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_FIADD:
    case ZYDIS_MNEMONIC_FISUB:
    case ZYDIS_MNEMONIC_FISUBR:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u)) {
            pl_u32 fop = ((pl_u32)(source->opcode & 7u) << 8u)
                       | ((pl_u32)source->raw.modrm.mod << 6u)
                       | ((pl_u32)source->raw.modrm.reg << 3u)
                       | source->raw.modrm.rm;
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_FIADD ? 0u
                           : source->mnemonic == ZYDIS_MNEMONIC_FISUB
                           ? 2u : 3u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 12u
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)options << 36u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CALL:
    case ZYDIS_MNEMONIC_JMP:
        if (source->meta.branch_type == ZYDIS_BRANCH_TYPE_FAR
                && out->visible_operand_count == 1u
                && (out->operands[0].kind == PL_X86_OPERAND_MEMORY
                    || out->operands[0].kind == PL_X86_OPERAND_POINTER)
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 48u
                    || out->operands[0].bits == 80u)) {
            pl_u32 direct = out->operands[0].kind
                          == PL_X86_OPERAND_POINTER;
            pl_u32 selector = direct
                ? out->operands[0].value.pointer.segment : 0u;
            out->machine_operation = PL_X86_MACHINE_FAR_TRANSFER;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_CALL)
                | ((pl_u64)direct << 1u)
                | ((pl_u64)out->operands[0].bits << 8u)
                | ((pl_u64)selector << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_ADD:
    case ZYDIS_MNEMONIC_OR:
    case ZYDIS_MNEMONIC_ADC:
    case ZYDIS_MNEMONIC_SBB:
    case ZYDIS_MNEMONIC_AND:
    case ZYDIS_MNEMONIC_SUB:
    case ZYDIS_MNEMONIC_XOR: {
        if (!(source->attributes & ZYDIS_ATTRIB_HAS_LOCK)
                || out->visible_operand_count != 2u
                || out->operands[0].kind != PL_X86_OPERAND_MEMORY
                || (out->operands[0].bits != 8u
                    && out->operands[0].bits != 16u
                    && out->operands[0].bits != 32u
                    && out->operands[0].bits != 64u))
            break;
        const pl_x86_operand *memory = &out->operands[0];
        const pl_x86_operand *value = &out->operands[1];
        int register_source = value->kind == PL_X86_OPERAND_REGISTER
                           && value->value.reg.class_id
                              == PL_X86_REGISTER_GPR
                           && value->value.reg.index < 16u
                           && value->bits == memory->bits;
        int immediate_source = value->kind == PL_X86_OPERAND_IMMEDIATE
            && ((memory->bits == 8u && value->bits == 8u)
                || (memory->bits == 16u
                    && (value->bits == 8u || value->bits == 16u))
                || (memory->bits == 32u
                    && (value->bits == 8u || value->bits == 32u))
                || (memory->bits == 64u
                    && (value->bits == 8u || value->bits == 32u)));
        if (!register_source && !immediate_source) break;
        pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_ADD ? 4u
                    : source->mnemonic == ZYDIS_MNEMONIC_OR ? 5u
                    : source->mnemonic == ZYDIS_MNEMONIC_ADC ? 6u
                    : source->mnemonic == ZYDIS_MNEMONIC_SBB ? 7u
                    : source->mnemonic == ZYDIS_MNEMONIC_AND ? 8u
                    : source->mnemonic == ZYDIS_MNEMONIC_SUB ? 9u : 10u;
        out->machine_operation = PL_X86_MACHINE_ATOMIC;
        out->machine_argument = kind
            | ((pl_u64)(memory->bits / 8u) << 8u);
        if (register_source) {
            out->machine_argument |=
                ((pl_u64)value->value.reg.index << 16u)
                | ((pl_u64)!!(value->value.reg.flags
                              & PL_X86_REGISTER_HIGH8) << 24u);
        } else {
            pl_u64 immediate = value->value.immediate;
            if ((value->flags & PL_X86_OPERAND_SIGNED)
                    && value->bits < 64u) {
                pl_u64 sign = 1ull << (value->bits - 1u);
                pl_u64 mask = (1ull << value->bits) - 1u;
                immediate = ((immediate & mask) ^ sign) - sign;
            }
            out->machine_argument |= (1ull << 25u)
                | ((immediate & 0xffffffffull) << 32u);
        }
        break;
    }
    case ZYDIS_MNEMONIC_INC:
    case ZYDIS_MNEMONIC_DEC:
        if ((source->attributes & ZYDIS_ATTRIB_HAS_LOCK)
                && out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 8u
                    || out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)) {
            out->machine_operation = PL_X86_MACHINE_ATOMIC;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_INC ? 11u : 12u)
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u);
        }
        break;
    case ZYDIS_MNEMONIC_BTS:
    case ZYDIS_MNEMONIC_BTR:
    case ZYDIS_MNEMONIC_BTC:
        if ((source->attributes & ZYDIS_ATTRIB_HAS_LOCK)
                && out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)) {
            const pl_x86_operand *value=&out->operands[1];
            int register_source=value->kind==PL_X86_OPERAND_REGISTER
                && value->value.reg.class_id==PL_X86_REGISTER_GPR
                && value->value.reg.index<16u && value->bits==out->operands[0].bits;
            int immediate_source=value->kind==PL_X86_OPERAND_IMMEDIATE
                && value->bits==8u && !(value->flags&PL_X86_OPERAND_SIGNED);
            if (!register_source && !immediate_source) break;
            pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_BTS ? 14u
                        : source->mnemonic == ZYDIS_MNEMONIC_BTR ? 15u
                        : 16u;
            out->machine_operation = PL_X86_MACHINE_ATOMIC;
            out->machine_argument = kind
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u);
            /* Immediate index selects within the operand; the register form
             * additionally selects a signed word in the memory bit string. */
            if (register_source)
                out->machine_argument|=(pl_u64)value->value.reg.index<<16u;
            else out->machine_argument|=(1ull<<25u)
                | ((value->value.immediate&255u)<<32u);
        }
        break;
    case ZYDIS_MNEMONIC_IN:
    case ZYDIS_MNEMONIC_OUT:
        if (out->visible_operand_count == 2u) {
            int write = source->mnemonic == ZYDIS_MNEMONIC_OUT;
            const pl_x86_operand *value = &out->operands[write ? 1u : 0u];
            const pl_x86_operand *port = &out->operands[write ? 0u : 1u];
            pl_u32 width = value->bits / 8u;
            pl_u32 dynamic = port->kind == PL_X86_OPERAND_REGISTER;
            pl_u32 coordinate = port->kind == PL_X86_OPERAND_IMMEDIATE
                ? (pl_u32)port->value.immediate & 0xffffu : 0u;
            if ((width == 1u || width == 2u || width == 4u)
                    && value->kind == PL_X86_OPERAND_REGISTER
                    && value->value.reg.class_id == PL_X86_REGISTER_GPR
                    && value->value.reg.index == 0u
                    && (port->kind == PL_X86_OPERAND_IMMEDIATE
                        || (dynamic
                            && port->value.reg.class_id
                               == PL_X86_REGISTER_GPR
                            && port->value.reg.index == 2u
                            && port->bits == 16u))) {
                out->machine_operation = PL_X86_MACHINE_PORT_IO;
                out->machine_argument = width | ((pl_u64)write << 8u)
                    | ((pl_u64)dynamic << 9u)
                    | ((pl_u64)coordinate << 16u);
            }
        }
        break;
    case ZYDIS_MNEMONIC_RDPMC:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_TIME;
            out->machine_argument = 2u;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_LMSW:
        if (out->visible_operand_count == 1u
                && out->operands[0].bits == 16u
                && (out->operands[0].kind == PL_X86_OPERAND_MEMORY
                    || (out->operands[0].kind == PL_X86_OPERAND_REGISTER
                        && out->operands[0].value.reg.class_id
                           == PL_X86_REGISTER_GPR
                        && out->operands[0].value.reg.index < 16u))) {
            pl_u32 memory = out->operands[0].kind
                          == PL_X86_OPERAND_MEMORY;
            pl_u32 source_coordinate = memory ? 0u
                : out->operands[0].value.reg.index;
            out->machine_operation = PL_X86_MACHINE_CR0_STATUS;
            out->machine_argument = PL_X86_CR0_WRITE_MACHINE_STATUS
                | (memory ? PL_X86_CR0_STATUS_MEMORY : 0u)
                | ((pl_u64)source_coordinate
                   << PL_X86_CR0_STATUS_REGISTER_SHIFT);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_SMSW:
        if (out->visible_operand_count == 1u
                && out->operands[0].bits == 16u
                && (out->operands[0].kind == PL_X86_OPERAND_MEMORY
                    || scalar_general_register(&out->operands[0]))) {
            pl_u32 memory = out->operands[0].kind
                          == PL_X86_OPERAND_MEMORY;
            pl_u32 target_coordinate = memory ? 0u
                : out->operands[0].value.reg.index;
            out->machine_operation = PL_X86_MACHINE_CR0_STATUS;
            out->machine_argument = PL_X86_CR0_READ_MACHINE_STATUS
                | (memory ? PL_X86_CR0_STATUS_MEMORY : 0u)
                | ((pl_u64)target_coordinate
                   << PL_X86_CR0_STATUS_REGISTER_SHIFT);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CLTS:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_CR0_STATUS;
            out->machine_argument = PL_X86_CR0_CLEAR_TASK_SWITCHED;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_RDTSC:
    case ZYDIS_MNEMONIC_RDTSCP:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_TIME;
            out->machine_argument =
                source->mnemonic == ZYDIS_MNEMONIC_RDTSCP;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_RDRAND:
    case ZYDIS_MNEMONIC_RDSEED:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && out->operands[0].value.reg.index < 16u
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)) {
            out->machine_operation = PL_X86_MACHINE_ENTROPY;
            out->machine_argument = out->operands[0].value.reg.index
                | ((pl_u64)out->operands[0].bits << 8u)
                | ((pl_u64)(source->mnemonic
                            == ZYDIS_MNEMONIC_RDSEED) << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_LFENCE:
    case ZYDIS_MNEMONIC_MFENCE:
    case ZYDIS_MNEMONIC_SFENCE:
    case ZYDIS_MNEMONIC_SERIALIZE:
    case ZYDIS_MNEMONIC_WBINVD:
    case ZYDIS_MNEMONIC_INVD:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_MEMORY_ORDER;
            out->machine_argument =
                source->mnemonic == ZYDIS_MNEMONIC_LFENCE ? 0u
              : source->mnemonic == ZYDIS_MNEMONIC_MFENCE ? 1u
              : source->mnemonic == ZYDIS_MNEMONIC_WBINVD ? 2u
              : source->mnemonic == ZYDIS_MNEMONIC_INVD ? 3u
              : source->mnemonic == ZYDIS_MNEMONIC_SFENCE ? 5u : 6u;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_CLFLUSH:
    case ZYDIS_MNEMONIC_CLWB:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY) {
            out->machine_operation = PL_X86_MACHINE_MEMORY_ORDER;
            out->machine_argument = source->mnemonic
                                  == ZYDIS_MNEMONIC_CLFLUSH ? 4u : 7u;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_MOVDQA:
    case ZYDIS_MNEMONIC_MOVDQU:
    case ZYDIS_MNEMONIC_MOVAPS:
    case ZYDIS_MNEMONIC_MOVAPD:
    case ZYDIS_MNEMONIC_MOVUPS:
    case ZYDIS_MNEMONIC_MOVUPD:
    case ZYDIS_MNEMONIC_MOVNTPS:
    case ZYDIS_MNEMONIC_MOVNTPD:
    case ZYDIS_MNEMONIC_PXOR:
    case ZYDIS_MNEMONIC_XORPS:
    case ZYDIS_MNEMONIC_XORPD:
    case ZYDIS_MNEMONIC_PAND:
    case ZYDIS_MNEMONIC_ANDPS:
    case ZYDIS_MNEMONIC_ANDPD:
    case ZYDIS_MNEMONIC_ANDNPS:
    case ZYDIS_MNEMONIC_ANDNPD:
    case ZYDIS_MNEMONIC_POR:
    case ZYDIS_MNEMONIC_ORPS:
    case ZYDIS_MNEMONIC_ORPD: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int mmx_logical = source->mnemonic == ZYDIS_MNEMONIC_PXOR
                       || source->mnemonic == ZYDIS_MNEMONIC_PAND
                       || source->mnemonic == ZYDIS_MNEMONIC_POR;
        if (mmx_logical
                && target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_MMX
                && target->value.reg.index < 8u
                && ((source_operand->kind == PL_X86_OPERAND_REGISTER
                     && source_operand->value.reg.class_id
                        == PL_X86_REGISTER_MMX
                     && source_operand->value.reg.index < 8u)
                    || (source_operand->kind == PL_X86_OPERAND_MEMORY
                        && source_operand->bits == 64u))) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_PXOR ? 0u
                           : source->mnemonic == ZYDIS_MNEMONIC_PAND ? 1u : 2u;
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 23u
                | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_MEMORY
                            ? 8u : 0u) << 8u)
                | ((pl_u64)fop << 16u)
                | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_REGISTER
                            ? source_operand->value.reg.index : 0u) << 32u)
                | ((pl_u64)target->value.reg.index << 36u)
                | ((pl_u64)options << 40u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
            break;
        }
        int move = source->mnemonic == ZYDIS_MNEMONIC_MOVDQA
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVDQU
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVAPS
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVAPD
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVUPS
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVUPD
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVNTPS
                   || source->mnemonic == ZYDIS_MNEMONIC_MOVNTPD;
        int target_vector = target->kind == PL_X86_OPERAND_REGISTER
                         && target->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && target->bits == 128u
                         && target->value.reg.index < 16u;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && (source_operand->bits == 64u
                             || source_operand->bits == 128u)
                         && source_operand->value.reg.index < 16u;
        int target_memory = target->kind == PL_X86_OPERAND_MEMORY
                         && target->bits == 128u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 128u;
        if (move ? !((target_vector && (source_vector || source_memory))
                     || (target_memory && source_vector))
                 : !(target_vector && (source_vector || source_memory)))
            break;
        pl_u32 kind = move ? 0u
                    : source->mnemonic == ZYDIS_MNEMONIC_ANDNPS
                   || source->mnemonic == ZYDIS_MNEMONIC_ANDNPD ? 24u
                    : source->mnemonic == ZYDIS_MNEMONIC_PXOR
                   || source->mnemonic == ZYDIS_MNEMONIC_XORPS
                   || source->mnemonic == ZYDIS_MNEMONIC_XORPD ? 1u
                    : source->mnemonic == ZYDIS_MNEMONIC_PAND
                   || source->mnemonic == ZYDIS_MNEMONIC_ANDPS
                   || source->mnemonic == ZYDIS_MNEMONIC_ANDPD ? 2u : 3u;
        pl_u32 aligned = (target_memory || source_memory)
                      && (source->mnemonic == ZYDIS_MNEMONIC_MOVDQA
                          || source->mnemonic == ZYDIS_MNEMONIC_MOVAPS
                          || source->mnemonic == ZYDIS_MNEMONIC_MOVAPD
                          || source->mnemonic == ZYDIS_MNEMONIC_MOVNTPS
                          || source->mnemonic == ZYDIS_MNEMONIC_MOVNTPD
                          || !move);
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = kind
            | ((pl_u64)(target_vector
                        ? target->value.reg.index : 0u) << 8u)
            | ((pl_u64)(source_vector
                        ? source_operand->value.reg.index : 0u) << 16u)
            | ((pl_u64)source_memory << 24u)
            | ((pl_u64)target_memory << 25u)
            | ((pl_u64)aligned << 26u);
        break;
    }
    case ZYDIS_MNEMONIC_MOVD: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int target_mmx = target->kind == PL_X86_OPERAND_REGISTER
                      && target->value.reg.class_id == PL_X86_REGISTER_MMX
                      && target->value.reg.index < 8u;
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u;
        int target_general = target->kind == PL_X86_OPERAND_REGISTER
                          && target->value.reg.class_id
                             == PL_X86_REGISTER_GPR
                          && target->bits == 32u
                          && target->value.reg.index < 16u;
        int source_general = source_operand->kind == PL_X86_OPERAND_REGISTER
                          && source_operand->value.reg.class_id
                             == PL_X86_REGISTER_GPR
                          && source_operand->bits == 32u
                          && source_operand->value.reg.index < 16u;
        int target_memory = target->kind == PL_X86_OPERAND_MEMORY
                         && target->bits == 32u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 32u;
        int target_vector = target->kind == PL_X86_OPERAND_REGISTER
                         && target->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && target->value.reg.index < 16u;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->value.reg.index < 16u;
        int from_vector = source_vector && (target_general || target_memory);
        int to_vector = target_vector && (source_general || source_memory);
        if (from_vector || to_vector) {
            pl_u32 general_index = target_general
                                 ? target->value.reg.index
                                 : source_general
                                 ? source_operand->value.reg.index : 0u;
            pl_u32 transfer = (pl_u32)from_vector | (general_index << 1u);
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 9u
                | ((pl_u64)(to_vector ? target->value.reg.index : 0u) << 8u)
                | ((pl_u64)(from_vector
                            ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)source_memory << 24u)
                | ((pl_u64)target_memory << 25u)
                | ((pl_u64)transfer << 32u);
            break;
        }
        int from_mmx = source_mmx && (target_general || target_memory);
        int to_mmx = target_mmx && (source_general || source_memory);
        if (!from_mmx && !to_mmx) break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 40u
            | ((pl_u64)(target_memory || source_memory ? 4u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(from_mmx
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)(to_mmx ? target->value.reg.index : 0u) << 36u)
            | ((pl_u64)from_mmx << 40u)
            | ((pl_u64)(target_general ? target->value.reg.index
                        : source_general ? source_operand->value.reg.index
                        : 0u) << 44u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_MOVQ:
    case ZYDIS_MNEMONIC_MOVNTQ: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int target_mmx = target->kind == PL_X86_OPERAND_REGISTER
                      && target->value.reg.class_id == PL_X86_REGISTER_MMX
                      && target->value.reg.index < 8u;
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u;
        int target_memory = target->kind == PL_X86_OPERAND_MEMORY
                         && target->bits == 64u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u;
        int target_vector = target->kind == PL_X86_OPERAND_REGISTER
                         && target->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && target->bits == 128u
                         && target->value.reg.index < 16u;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && (source_operand->bits == 64u
                             || source_operand->bits == 128u)
                         && source_operand->value.reg.index < 16u;
        int target_general = target->kind == PL_X86_OPERAND_REGISTER
                          && target->value.reg.class_id
                             == PL_X86_REGISTER_GPR
                          && target->bits == 64u
                          && target->value.reg.index < 16u;
        int source_general = source_operand->kind == PL_X86_OPERAND_REGISTER
                          && source_operand->value.reg.class_id
                             == PL_X86_REGISTER_GPR
                          && source_operand->bits == 64u
                          && source_operand->value.reg.index < 16u;
        int from_vector = source_vector && (target_general || target_memory);
        int to_vector = target_vector && (source_general || source_memory);
        if (target_vector && source_vector) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 39u
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)source_operand->value.reg.index << 16u)
                | (3ull << 32u); /* 64-bit lane, clear the upper lane */
            break;
        }
        if (from_vector || to_vector) {
            pl_u32 general_index = target_general
                                 ? target->value.reg.index
                                 : source_general
                                 ? source_operand->value.reg.index : 0u;
            pl_u32 transfer = (pl_u32)from_vector | (general_index << 1u);
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 13u
                | ((pl_u64)(to_vector
                            ? target->value.reg.index : 0u) << 8u)
                | ((pl_u64)(from_vector
                            ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)(to_vector && source_memory) << 24u)
                | ((pl_u64)(from_vector && target_memory) << 25u)
                | ((pl_u64)transfer << 32u);
            break;
        }
        int from_mmx_general = source_mmx && target_general;
        int to_mmx_general = target_mmx && source_general;
        if (from_mmx_general || to_mmx_general) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 45u | ((pl_u64)fop << 16u)
                | ((pl_u64)(from_mmx_general
                            ? source_operand->value.reg.index : 0u) << 32u)
                | ((pl_u64)(to_mmx_general
                            ? target->value.reg.index : 0u) << 36u)
                | ((pl_u64)from_mmx_general << 40u)
                | ((pl_u64)(target_general
                            ? target->value.reg.index
                            : source_operand->value.reg.index) << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
            break;
        }
        if ((!target_mmx || (!source_mmx && !source_memory))
                && (!target_memory || !source_mmx)) break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 17u
            | ((pl_u64)(target_memory || source_memory ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_mmx
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)(target_mmx
                        ? target->value.reg.index : 0u) << 36u)
            | ((pl_u64)target_memory << 40u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_MOVQ2DQ:
    case ZYDIS_MNEMONIC_MOVDQ2Q: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int to_vector = source->mnemonic == ZYDIS_MNEMONIC_MOVQ2DQ;
        pl_u32 target_class = to_vector ? PL_X86_REGISTER_VECTOR
                                        : PL_X86_REGISTER_MMX;
        pl_u32 source_class = to_vector ? PL_X86_REGISTER_MMX
                                        : PL_X86_REGISTER_VECTOR;
        pl_u32 target_limit = to_vector ? 16u : 8u;
        pl_u32 source_limit = to_vector ? 8u : 16u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != target_class
                || target->value.reg.index >= target_limit
                || source_operand->kind != PL_X86_OPERAND_REGISTER
                || source_operand->value.reg.class_id != source_class
                || source_operand->value.reg.index >= source_limit)
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = PL_X86_VECTOR_MMX_LANE_TRANSFER
            | ((pl_u64)target->value.reg.index << PL_X86_VECTOR_TARGET_SHIFT)
            | ((pl_u64)source_operand->value.reg.index
               << PL_X86_VECTOR_SOURCE_SHIFT)
            | ((pl_u64)!to_vector << PL_X86_VECTOR_IMMEDIATE_SHIFT);
        break;
    }
    case ZYDIS_MNEMONIC_PBLENDVB: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 128u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_VECTOR
                || target->bits != 128u || target->value.reg.index >= 16u
                || (!source_vector && !source_memory))
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = PL_X86_VECTOR_BYTE_BLEND
            | ((pl_u64)target->value.reg.index
               << PL_X86_VECTOR_TARGET_SHIFT)
            | ((pl_u64)(source_vector
                        ? source_operand->value.reg.index : 0u)
               << PL_X86_VECTOR_SOURCE_SHIFT)
            | (source_memory ? PL_X86_VECTOR_SOURCE_MEMORY
                             | PL_X86_VECTOR_MEMORY_READ : 0u);
        break;
    }
    case ZYDIS_MNEMONIC_PMOVZXDQ: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->value.reg.index < 16u
                         && source_operand->bits == 64u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_VECTOR
                || target->bits != 128u || target->value.reg.index >= 16u
                || (!source_vector && !source_memory))
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = 10u
            | ((pl_u64)target->value.reg.index
               << PL_X86_VECTOR_TARGET_SHIFT)
            | ((pl_u64)(source_vector
                        ? source_operand->value.reg.index : 0u)
               << PL_X86_VECTOR_SOURCE_SHIFT)
            | (source_memory ? PL_X86_VECTOR_SOURCE_MEMORY
                             | PL_X86_VECTOR_MEMORY_READ : 0u)
            | ((pl_u64)PL_X86_PACKED_ZERO_EXTEND_DWORD_TO_QWORD
               << PL_X86_VECTOR_IMMEDIATE_SHIFT);
        break;
    }
    case ZYDIS_MNEMONIC_PSHUFB: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 128u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && (source_vector || source_memory)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = PL_X86_VECTOR_BYTE_SHUFFLE
                | ((pl_u64)target->value.reg.index
                   << PL_X86_VECTOR_TARGET_SHIFT)
                | ((pl_u64)(source_vector
                            ? source_operand->value.reg.index : 0u)
                   << PL_X86_VECTOR_SOURCE_SHIFT)
                | (source_memory ? PL_X86_VECTOR_SOURCE_MEMORY
                                 | PL_X86_VECTOR_MEMORY_READ : 0u);
            break;
        }
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->bits == 64u
                      && source_operand->value.reg.index < 8u;
        int source_mmx_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                             && source_operand->bits == 64u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->bits != 64u || target->value.reg.index >= 8u
                || (!source_mmx && !source_mmx_memory))
            break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = PL_X86_X87_BYTE_SHUFFLE
            | ((pl_u64)(source_mmx_memory ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_mmx
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PEXTRD:
    case ZYDIS_MNEMONIC_PEXTRQ: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *lane = &out->operands[2];
        pl_u32 bits = source->mnemonic == ZYDIS_MNEMONIC_PEXTRQ ? 64u : 32u;
        int target_gpr = target->kind == PL_X86_OPERAND_REGISTER
                      && target->value.reg.class_id == PL_X86_REGISTER_GPR
                      && target->bits == bits && target->value.reg.index < 16u;
        int target_memory = target->kind == PL_X86_OPERAND_MEMORY
                         && target->bits == bits;
        if ((!target_gpr && !target_memory)
                || source_operand->kind != PL_X86_OPERAND_REGISTER
                || source_operand->value.reg.class_id
                   != PL_X86_REGISTER_VECTOR
                || source_operand->bits != 128u
                || source_operand->value.reg.index >= 16u
                || lane->kind != PL_X86_OPERAND_IMMEDIATE
                || lane->bits != 8u)
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = PL_X86_VECTOR_EXTRACT_LANE
            | ((pl_u64)(target_gpr ? target->value.reg.index : 0u)
               << PL_X86_VECTOR_TARGET_SHIFT)
            | ((pl_u64)source_operand->value.reg.index
               << PL_X86_VECTOR_SOURCE_SHIFT)
            | (target_memory ? PL_X86_VECTOR_TARGET_MEMORY : 0u)
            | (((lane->value.immediate & (bits == 64u ? 1u : 3u))
                | (bits == 64u ? 4u : 0u))
               << PL_X86_VECTOR_IMMEDIATE_SHIFT);
        break;
    }
    case ZYDIS_MNEMONIC_PINSRD:
    case ZYDIS_MNEMONIC_PINSRQ: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *lane = &out->operands[2];
        pl_u32 bits = source->mnemonic == ZYDIS_MNEMONIC_PINSRQ ? 64u : 32u;
        int source_general = source_operand->kind == PL_X86_OPERAND_REGISTER
                          && source_operand->value.reg.class_id
                             == PL_X86_REGISTER_GPR
                          && source_operand->bits == bits
                          && source_operand->value.reg.index < 16u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == bits;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_VECTOR
                || target->bits != 128u || target->value.reg.index >= 16u
                || (!source_general && !source_memory)
                || lane->kind != PL_X86_OPERAND_IMMEDIATE
                || lane->bits != 8u)
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = PL_X86_VECTOR_INSERT_LANE
            | ((pl_u64)target->value.reg.index
               << PL_X86_VECTOR_TARGET_SHIFT)
            | ((pl_u64)(source_general
                        ? source_operand->value.reg.index : 0u)
               << PL_X86_VECTOR_SOURCE_SHIFT)
            | (source_memory ? PL_X86_VECTOR_SOURCE_MEMORY : 0u)
            | (((lane->value.immediate & (bits == 64u ? 1u : 3u))
                | (bits == 64u ? 4u : 0u))
               << PL_X86_VECTOR_IMMEDIATE_SHIFT);
        break;
    }
    case ZYDIS_MNEMONIC_PALIGNR: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *amount = &out->operands[2];
        if (amount->kind != PL_X86_OPERAND_IMMEDIATE
                || amount->bits != 8u)
            break;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_vector_memory =
            source_operand->kind == PL_X86_OPERAND_MEMORY
            && source_operand->bits == 128u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && (source_vector || source_vector_memory)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = PL_X86_VECTOR_ALIGN_RIGHT
                | ((pl_u64)target->value.reg.index
                   << PL_X86_VECTOR_TARGET_SHIFT)
                | ((pl_u64)(source_vector
                            ? source_operand->value.reg.index : 0u)
                   << PL_X86_VECTOR_SOURCE_SHIFT)
                | (source_vector_memory ? PL_X86_VECTOR_SOURCE_MEMORY : 0u)
                | ((amount->value.immediate & 0xffu)
                   << PL_X86_VECTOR_IMMEDIATE_SHIFT);
            break;
        }
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->bits == 64u
                      && source_operand->value.reg.index < 8u;
        int source_mmx_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                             && source_operand->bits == 64u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->bits != 64u || target->value.reg.index >= 8u
                || (!source_mmx && !source_mmx_memory))
            break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = PL_X86_X87_ALIGN_RIGHT
            | ((pl_u64)(source_mmx_memory ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_mmx
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((amount->value.immediate & 0xffu) << 48u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_MOVLPD:
    case ZYDIS_MNEMONIC_MOVLPS:
    case ZYDIS_MNEMONIC_MOVHPD:
    case ZYDIS_MNEMONIC_MOVHPS: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int target_vector = target->kind == PL_X86_OPERAND_REGISTER
                         && target->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && target->value.reg.index < 16u;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->value.reg.index < 16u;
        int target_memory = target->kind == PL_X86_OPERAND_MEMORY
                         && target->bits == 64u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u;
        if (!((target_vector && source_memory)
                || (target_memory && source_vector))) break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = 14u
            | ((pl_u64)(target_vector ? target->value.reg.index : 0u) << 8u)
            | ((pl_u64)(source_vector
                        ? source_operand->value.reg.index : 0u) << 16u)
            | ((pl_u64)source_memory << 24u)
            | ((pl_u64)target_memory << 25u)
            | ((pl_u64)(source->mnemonic == ZYDIS_MNEMONIC_MOVHPD
                       || source->mnemonic == ZYDIS_MNEMONIC_MOVHPS) << 32u);
        break;
    }
    case ZYDIS_MNEMONIC_PINSRW: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *lane = &out->operands[2];
        if (lane->kind != PL_X86_OPERAND_IMMEDIATE || lane->bits != 8u)
            break;
        int source_general = source_operand->kind == PL_X86_OPERAND_REGISTER
                          && source_operand->value.reg.class_id
                             == PL_X86_REGISTER_GPR
                          && source_operand->bits == 32u
                          && source_operand->value.reg.index < 16u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 16u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && (source_general || source_memory)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 15u
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)(source_general
                            ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)source_memory << 24u)
                | ((lane->value.immediate & 7u) << 32u);
            break;
        }
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->bits != 64u || target->value.reg.index >= 8u
                || (!source_general && !source_memory)) break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 46u
            | ((pl_u64)(source_memory ? 2u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((pl_u64)(source_general
                        ? source_operand->value.reg.index : 0u) << 44u)
            | ((lane->value.immediate & 3u) << 48u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PEXTRW: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *lane = &out->operands[2];
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->bits == 64u
                      && source_operand->value.reg.index < 8u;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_GPR
                || target->bits != 32u || target->value.reg.index >= 16u
                || (!source_mmx && !source_vector)
                || lane->kind != PL_X86_OPERAND_IMMEDIATE
                || lane->bits != 8u)
            break;
        pl_u32 word = (pl_u32)lane->value.immediate
                    & (source_mmx ? 3u : 7u);
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = 22u
            | ((pl_u64)target->value.reg.index << 8u)
            | ((pl_u64)source_operand->value.reg.index << 16u)
            | ((pl_u64)(word | ((pl_u32)source_mmx << 3u)) << 32u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PMOVMSKB: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_GPR
                || target->bits != 32u || target->value.reg.index >= 16u
                || source_operand->kind != PL_X86_OPERAND_REGISTER)
            break;
        if (source_operand->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && source_operand->bits == 128u
                && source_operand->value.reg.index < 16u) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = PL_X86_VECTOR_BYTE_SIGN_MASK
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)source_operand->value.reg.index << 16u);
            break;
        }
        if (source_operand->value.reg.class_id != PL_X86_REGISTER_MMX
                || source_operand->bits != 64u
                || source_operand->value.reg.index >= 8u)
            break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 55u | ((pl_u64)fop << 16u)
            | ((pl_u64)source_operand->value.reg.index << 32u)
            | ((pl_u64)target->value.reg.index << 44u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_MOVHLPS:
    case ZYDIS_MNEMONIC_MOVLHPS: {
        if (out->visible_operand_count != 2u
                || out->operands[0].kind != PL_X86_OPERAND_REGISTER
                || out->operands[0].value.reg.class_id
                   != PL_X86_REGISTER_VECTOR
                || out->operands[0].value.reg.index >= 16u
                || out->operands[1].kind != PL_X86_OPERAND_REGISTER
                || out->operands[1].value.reg.class_id
                   != PL_X86_REGISTER_VECTOR
                || out->operands[1].value.reg.index >= 16u)
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = PL_X86_VECTOR_MOVE_LANE
            | ((pl_u64)out->operands[0].value.reg.index << 8u)
            | ((pl_u64)out->operands[1].value.reg.index << 16u)
            | ((pl_u64)(source->mnemonic == ZYDIS_MNEMONIC_MOVLHPS)
               << PL_X86_VECTOR_IMMEDIATE_SHIFT);
        break;
    }
    case ZYDIS_MNEMONIC_LDMXCSR:
    case ZYDIS_MNEMONIC_STMXCSR: {
        if (out->visible_operand_count != 1u
                || out->operands[0].kind != PL_X86_OPERAND_MEMORY
                || out->operands[0].bits != 32u)
            break;
        pl_u32 store = source->mnemonic == ZYDIS_MNEMONIC_STMXCSR;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = PL_X86_VECTOR_MXCSR
            | ((pl_u64)!store << 24u)
            | ((pl_u64)store << 25u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PSLLDQ:
    case ZYDIS_MNEMONIC_PSRLDQ: {
        if (out->visible_operand_count != 2u
                || out->operands[0].kind != PL_X86_OPERAND_REGISTER
                || out->operands[0].value.reg.class_id
                   != PL_X86_REGISTER_VECTOR
                || out->operands[0].bits != 128u
                || out->operands[0].value.reg.index >= 16u
                || out->operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                || out->operands[1].bits != 8u)
            break;
        pl_u32 count = out->operands[1].value.immediate > 15u
                     ? 16u : (pl_u32)out->operands[1].value.immediate;
        pl_u32 left = source->mnemonic == ZYDIS_MNEMONIC_PSLLDQ;
        pl_u32 target = out->operands[0].value.reg.index;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = 23u | ((pl_u64)target << 8u)
            | ((pl_u64)target << 16u)
            | ((pl_u64)(count | (left << 5u)) << 32u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PSHUFD:
    case ZYDIS_MNEMONIC_PSHUFHW:
    case ZYDIS_MNEMONIC_PSHUFLW:
    case ZYDIS_MNEMONIC_SHUFPS:
    case ZYDIS_MNEMONIC_MOVSHDUP:
    case ZYDIS_MNEMONIC_MOVSLDUP: {
        int fixed_control = source->mnemonic == ZYDIS_MNEMONIC_MOVSHDUP
                         || source->mnemonic == ZYDIS_MNEMONIC_MOVSLDUP;
        if (out->visible_operand_count != (fixed_control ? 2u : 3u)) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *control = fixed_control ? 0 : &out->operands[2];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 128u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_VECTOR
                || target->bits != 128u || target->value.reg.index >= 16u
                || (!source_vector && !source_memory)
                || (!fixed_control
                    && (control->kind != PL_X86_OPERAND_IMMEDIATE
                        || control->bits != 8u)))
            break;
        pl_u64 control_value = source->mnemonic == ZYDIS_MNEMONIC_MOVSHDUP
                             ? 0xf5u
                             : source->mnemonic == ZYDIS_MNEMONIC_MOVSLDUP
                             ? 0xa0u : control->value.immediate & 0xffu;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument =
              (fixed_control ? PL_X86_VECTOR_FIXED_DWORD_SHUFFLE
             : source->mnemonic == ZYDIS_MNEMONIC_PSHUFD ? 7u
             : source->mnemonic == ZYDIS_MNEMONIC_PSHUFHW ? 27u
             : source->mnemonic == ZYDIS_MNEMONIC_PSHUFLW
             ? PL_X86_VECTOR_SHUFFLE_LOW_WORDS : 8u)
            | ((pl_u64)target->value.reg.index << 8u)
            | ((pl_u64)(source_vector
                        ? source_operand->value.reg.index : 0u) << 16u)
            | ((pl_u64)source_memory << 24u)
            | ((pl_u64)source_memory << 26u)
            | (control_value << 32u);
        break;
    }
    case ZYDIS_MNEMONIC_SHUFPD: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *input = &out->operands[1];
        const pl_x86_operand *control = &out->operands[2];
        int source_vector = input->kind == PL_X86_OPERAND_REGISTER
                         && input->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && input->bits == 128u
                         && input->value.reg.index < 16u;
        int source_memory = input->kind == PL_X86_OPERAND_MEMORY
                         && input->bits == 128u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_VECTOR
                || target->bits != 128u || target->value.reg.index >= 16u
                || (!source_vector && !source_memory)
                || control->kind != PL_X86_OPERAND_IMMEDIATE
                || control->bits != 8u)
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = 40u
            | ((pl_u64)target->value.reg.index << 8u)
            | ((pl_u64)(source_vector ? input->value.reg.index : 0u) << 16u)
            | ((pl_u64)source_memory << 24u)
            | ((pl_u64)source_memory << 26u)
            | ((control->value.immediate & 3u) << 32u);
        break;
    }
    case ZYDIS_MNEMONIC_MOVMSKPD:
    case ZYDIS_MNEMONIC_MOVMSKPS: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *input = &out->operands[1];
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_GPR
                || target->bits != 32u || target->value.reg.index >= 16u
                || input->kind != PL_X86_OPERAND_REGISTER
                || input->value.reg.class_id != PL_X86_REGISTER_VECTOR
                || input->bits != 128u || input->value.reg.index >= 16u)
            break;
        out->machine_operation = PL_X86_MACHINE_VECTOR;
        out->machine_argument = 41u
            | ((pl_u64)target->value.reg.index << 8u)
            | ((pl_u64)input->value.reg.index << 16u)
            | ((pl_u64)(source->mnemonic == ZYDIS_MNEMONIC_MOVMSKPD)
               << 32u);
        break;
    }
    case ZYDIS_MNEMONIC_PSHUFW: {
        if (out->visible_operand_count != 3u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        const pl_x86_operand *control = &out->operands[2];
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u;
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->value.reg.index >= 8u
                || (!source_mmx && !source_memory)
                || control->kind != PL_X86_OPERAND_IMMEDIATE
                || control->bits != 8u)
            break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 38u
            | ((pl_u64)(source_memory ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_mmx
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((control->value.immediate & 0xffu) << 48u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PSADBW:
    case ZYDIS_MNEMONIC_PSUBB:
    case ZYDIS_MNEMONIC_PCMPGTW:
    case ZYDIS_MNEMONIC_PANDN:
    case ZYDIS_MNEMONIC_PUNPCKHBW:
    case ZYDIS_MNEMONIC_PMADDWD:
    case ZYDIS_MNEMONIC_PMADDUBSW:
    case ZYDIS_MNEMONIC_PADDQ:
    case ZYDIS_MNEMONIC_PMULHUW:
    case ZYDIS_MNEMONIC_PMINSW:
    case ZYDIS_MNEMONIC_UNPCKLPS:
    case ZYDIS_MNEMONIC_PUNPCKLDQ:
    case ZYDIS_MNEMONIC_PUNPCKHQDQ:
    case ZYDIS_MNEMONIC_UNPCKHPD:
    case ZYDIS_MNEMONIC_PUNPCKHWD:
    case ZYDIS_MNEMONIC_PSUBW:
    case ZYDIS_MNEMONIC_PUNPCKLQDQ:
    case ZYDIS_MNEMONIC_UNPCKLPD:
    case ZYDIS_MNEMONIC_PMULUDQ:
    case ZYDIS_MNEMONIC_PCMPGTB:
    case ZYDIS_MNEMONIC_PMULHW:
    case ZYDIS_MNEMONIC_PACKUSWB:
    case ZYDIS_MNEMONIC_PADDSW:
    case ZYDIS_MNEMONIC_PSLLW:
    case ZYDIS_MNEMONIC_PMAXSW:
    case ZYDIS_MNEMONIC_PSUBUSB:
    case ZYDIS_MNEMONIC_PUNPCKLWD:
    case ZYDIS_MNEMONIC_PADDUSB:
    case ZYDIS_MNEMONIC_PAVGB:
    case ZYDIS_MNEMONIC_PAVGW:
    case ZYDIS_MNEMONIC_PMAXUB:
    case ZYDIS_MNEMONIC_PSRAD:
    case ZYDIS_MNEMONIC_UNPCKHPS:
    case ZYDIS_MNEMONIC_PUNPCKHDQ:
    case ZYDIS_MNEMONIC_PUNPCKLBW:
    case ZYDIS_MNEMONIC_PACKSSDW:
    case ZYDIS_MNEMONIC_PADDSB:
    case ZYDIS_MNEMONIC_PADDUSW:
    case ZYDIS_MNEMONIC_PMINUB:
    case ZYDIS_MNEMONIC_PSRAW:
    case ZYDIS_MNEMONIC_PSRLW:
    case ZYDIS_MNEMONIC_PACKSSWB:
    case ZYDIS_MNEMONIC_PSUBUSW:
    case ZYDIS_MNEMONIC_PHADDD:
    case ZYDIS_MNEMONIC_PMULHRSW:
    case ZYDIS_MNEMONIC_PHSUBD:
    case ZYDIS_MNEMONIC_PSIGNB:
    case ZYDIS_MNEMONIC_PHADDW:
    case ZYDIS_MNEMONIC_PSIGND:
    case ZYDIS_MNEMONIC_PABSB:
    case ZYDIS_MNEMONIC_PABSW:
    case ZYDIS_MNEMONIC_PABSD:
    case ZYDIS_MNEMONIC_PHSUBW: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        pl_u32 operation = source->mnemonic == ZYDIS_MNEMONIC_PSADBW ? 9u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSUBB ? 10u
                         : source->mnemonic == ZYDIS_MNEMONIC_PCMPGTW ? 11u
                         : source->mnemonic == ZYDIS_MNEMONIC_PANDN ? 12u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKHBW ? 13u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMADDWD ? 14u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMADDUBSW
                           ? PL_X86_PACKED_MULTIPLY_ADD_UNSIGNED_SIGNED_BYTE
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDQ ? 15u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMULHUW ? 16u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMINSW ? 17u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKHQDQ
                           || source->mnemonic == ZYDIS_MNEMONIC_UNPCKHPD
                           ? 19u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKHWD
                           ? 20u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSUBW
                           ? 21u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKLQDQ
                           ? 22u
                         : source->mnemonic == ZYDIS_MNEMONIC_UNPCKLPD
                           ? 22u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMULUDQ
                           ? 23u
                         : source->mnemonic == ZYDIS_MNEMONIC_PCMPGTB
                           ? 24u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMULHW
                           ? 25u
                         : source->mnemonic == ZYDIS_MNEMONIC_PACKUSWB
                           ? 26u
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDSW
                           ? 27u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSLLW
                           ? 28u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKLWD
                           ? 29u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMAXSW
                           ? 30u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSUBUSB
                           ? 31u
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDUSB
                           ? 32u
                         : source->mnemonic == ZYDIS_MNEMONIC_PAVGB
                           ? 33u
                         : source->mnemonic == ZYDIS_MNEMONIC_PAVGW
                           ? 34u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMAXUB
                           ? 35u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSRAD
                           ? 36u
                         : source->mnemonic == ZYDIS_MNEMONIC_UNPCKHPS
                           ? 37u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKHDQ
                           ? 38u
                         : source->mnemonic == ZYDIS_MNEMONIC_PUNPCKLBW
                           ? 39u
                         : source->mnemonic == ZYDIS_MNEMONIC_PACKSSDW
                           ? 40u
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDSB
                           ? 41u
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDUSW
                           ? 42u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMINUB
                           ? 43u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSRAW
                           ? 44u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSRLW
                           ? 45u
                         : source->mnemonic == ZYDIS_MNEMONIC_PACKSSWB
                           ? 46u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSUBUSW
                           ? 47u
                         : source->mnemonic == ZYDIS_MNEMONIC_PHADDD
                           ? PL_X86_PACKED_HORIZONTAL_ADD_DWORD
                         : source->mnemonic == ZYDIS_MNEMONIC_PMULHRSW
                           ? PL_X86_PACKED_MULTIPLY_HIGH_ROUND_SCALE_WORD
                         : source->mnemonic == ZYDIS_MNEMONIC_PHSUBD
                           ? PL_X86_PACKED_HORIZONTAL_SUBTRACT_DWORD
                         : source->mnemonic == ZYDIS_MNEMONIC_PSIGNB
                            ? PL_X86_PACKED_SIGN_BYTE
                         : source->mnemonic == ZYDIS_MNEMONIC_PHADDW
                           ? PL_X86_PACKED_HORIZONTAL_ADD_WORD
                         : source->mnemonic == ZYDIS_MNEMONIC_PSIGND
                           ? PL_X86_PACKED_SIGN_DWORD
                         : source->mnemonic == ZYDIS_MNEMONIC_PABSB
                           ? PL_X86_PACKED_ABSOLUTE
                         : source->mnemonic == ZYDIS_MNEMONIC_PABSW
                           ? PL_X86_PACKED_ABSOLUTE + 1u
                         : source->mnemonic == ZYDIS_MNEMONIC_PABSD
                           ? PL_X86_PACKED_ABSOLUTE + 2u
                         : source->mnemonic == ZYDIS_MNEMONIC_PHSUBW
                           ? PL_X86_PACKED_HORIZONTAL_SUBTRACT_WORD
                            : 18u;
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->value.reg.index < 16u
                         && (source_operand->bits == 64u
                             || source_operand->bits == 128u);
        int source_vector_memory =
            source_operand->kind == PL_X86_OPERAND_MEMORY
            && source_operand->bits == 128u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && source_operand->kind == PL_X86_OPERAND_IMMEDIATE
                && source_operand->bits == 8u
                && (operation == 28u || operation == 36u
                    || operation == 44u || operation == 45u)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument =
                PL_X86_VECTOR_PACKED_SHIFT_IMMEDIATE
                | ((pl_u64)target->value.reg.index
                   << PL_X86_PACKED_SHIFT_TARGET_SHIFT)
                | ((pl_u64)operation
                   << PL_X86_PACKED_SHIFT_OPERATION_SHIFT)
                | ((source_operand->value.immediate & 0xffu)
                   << PL_X86_PACKED_SHIFT_IMMEDIATE_SHIFT);
            break;
        }
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_MMX
                && target->bits == 64u && target->value.reg.index < 8u
                && source_operand->kind == PL_X86_OPERAND_IMMEDIATE
                && source_operand->bits == 8u
                && (operation == 28u || operation == 36u
                    || operation == 44u || operation == 45u)) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = PL_X86_X87_PACKED_SHIFT_IMMEDIATE
                | ((pl_u64)fop << 16u)
                | ((pl_u64)target->value.reg.index << 36u)
                | ((pl_u64)(operation & 3u) << 40u)
                | ((pl_u64)(operation >> 2u) << 44u)
                | ((source_operand->value.immediate & 0xffu) << 48u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
            break;
        }
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && (source_vector || source_vector_memory)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 10u
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)(source_vector
                            ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)source_vector_memory << 24u)
                | ((pl_u64)source_vector_memory << 26u)
                | ((pl_u64)operation << 32u);
            break;
        }
        int source_mmx = source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u
                      && (source_operand->bits == 32u
                          || source_operand->bits == 64u);
        int source_mmx_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                             && source_operand->bits
                                == ((operation == 18u || operation == 29u
                                     || operation == 39u)
                                    ? 32u : 64u);
        if (operation
                > PL_X86_PACKED_MULTIPLY_ADD_UNSIGNED_SIGNED_BYTE
                || target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->bits != 64u || target->value.reg.index >= 8u
                || (!source_mmx && !source_mmx_memory))
            break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 37u
            | ((pl_u64)(source_mmx_memory
                        ? source_operand->bits / 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_mmx
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((pl_u64)operation << 40u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PADDD: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_memory = source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 128u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u
                && target->value.reg.index < 16u
                && (source_vector || source_memory)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 4u
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)(source_vector
                    ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)source_memory << 24u)
                | ((pl_u64)source_memory << 26u);
            break;
        }
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->value.reg.index >= 8u
                || !((source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u)
                     || (source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u))) break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 18u
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_MEMORY
                        ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_REGISTER
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PSUBD:
    case ZYDIS_MNEMONIC_PCMPEQW:
    case ZYDIS_MNEMONIC_PCMPEQD:
    case ZYDIS_MNEMONIC_PMULLW:
    case ZYDIS_MNEMONIC_PSUBSW:
    case ZYDIS_MNEMONIC_PSUBSB:
    case ZYDIS_MNEMONIC_PADDB:
    case ZYDIS_MNEMONIC_PADDW:
    case ZYDIS_MNEMONIC_PSUBQ: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_vector_memory =
            source_operand->kind == PL_X86_OPERAND_MEMORY
            && source_operand->bits == 128u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && (source_vector || source_vector_memory)) {
            pl_u32 vector_operation =
                  source->mnemonic == ZYDIS_MNEMONIC_PMULLW ? 49u
                : source->mnemonic == ZYDIS_MNEMONIC_PSUBQ ? 50u
                : source->mnemonic == ZYDIS_MNEMONIC_PCMPEQW ? 51u
                : source->mnemonic == ZYDIS_MNEMONIC_PCMPEQD ? 52u
                : source->mnemonic == ZYDIS_MNEMONIC_PSUBD ? 53u
                : source->mnemonic == ZYDIS_MNEMONIC_PSUBSW ? 54u
                : source->mnemonic == ZYDIS_MNEMONIC_PSUBSB ? 55u
                : source->mnemonic == ZYDIS_MNEMONIC_PADDB ? 56u
                : 57u; /* PADDW */
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 10u
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)(source_vector
                            ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)source_vector_memory << 24u)
                | ((pl_u64)source_vector_memory << 26u)
                | ((pl_u64)vector_operation << 32u);
            break;
        }
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->value.reg.index >= 8u
                || !((source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u)
                     || (source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u)))
            break;
        pl_u32 operation = source->mnemonic == ZYDIS_MNEMONIC_PSUBD ? 0u
                         : source->mnemonic == ZYDIS_MNEMONIC_PCMPEQW ? 1u
                         : source->mnemonic == ZYDIS_MNEMONIC_PCMPEQD ? 2u
                         : source->mnemonic == ZYDIS_MNEMONIC_PMULLW ? 3u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSUBSW ? 4u
                         : source->mnemonic == ZYDIS_MNEMONIC_PSUBSB ? 5u
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDB ? 6u
                         : source->mnemonic == ZYDIS_MNEMONIC_PADDW ? 7u
                         : 8u;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 37u
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_MEMORY
                        ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_REGISTER
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((pl_u64)(operation & 3u) << 40u)
            | ((pl_u64)(operation >> 2u) << 44u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PCMPEQB:
    case ZYDIS_MNEMONIC_PCMPGTD: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        int source_vector = source_operand->kind == PL_X86_OPERAND_REGISTER
                         && source_operand->value.reg.class_id
                            == PL_X86_REGISTER_VECTOR
                         && source_operand->bits == 128u
                         && source_operand->value.reg.index < 16u;
        int source_vector_memory =
            source_operand->kind == PL_X86_OPERAND_MEMORY
            && source_operand->bits == 128u;
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && (source_vector || source_vector_memory)) {
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument = 10u
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)(source_vector
                            ? source_operand->value.reg.index : 0u) << 16u)
                | ((pl_u64)source_vector_memory << 24u)
                | ((pl_u64)source_vector_memory << 26u)
                | ((pl_u64)(source->mnemonic == ZYDIS_MNEMONIC_PCMPEQB
                            ? 48u : 58u) << 32u);
            break;
        }
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->value.reg.index >= 8u
                || !((source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u)
                     || (source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u))) break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument =
              (source->mnemonic == ZYDIS_MNEMONIC_PCMPEQB ? 24u : 25u)
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_MEMORY
                        ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_REGISTER
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PSRLD:
    case ZYDIS_MNEMONIC_PSLLD: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && source_operand->kind == PL_X86_OPERAND_IMMEDIATE
                && source_operand->bits == 8u) {
            pl_u32 target_index = target->value.reg.index;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument =
                  (source->mnemonic == ZYDIS_MNEMONIC_PSRLD ? 5u : 6u)
                | ((pl_u64)target_index << 8u)
                | ((pl_u64)target_index << 16u)
                | ((source_operand->value.immediate & 0xffu) << 32u);
            break;
        }
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && ((source_operand->kind == PL_X86_OPERAND_REGISTER
                     && source_operand->value.reg.class_id
                        == PL_X86_REGISTER_VECTOR
                     && source_operand->bits == 128u
                     && source_operand->value.reg.index < 16u)
                    || (source_operand->kind == PL_X86_OPERAND_MEMORY
                        && source_operand->bits == 128u))) {
            pl_u32 memory = source_operand->kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument =
                  (source->mnemonic == ZYDIS_MNEMONIC_PSRLD ? 5u : 6u)
                | ((pl_u64)target->value.reg.index << 8u)
                | ((pl_u64)(memory ? 0u
                    : source_operand->value.reg.index) << 16u)
                | ((pl_u64)memory << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
            break;
        }
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_MMX
                && target->value.reg.index < 8u
                && source_operand->kind == PL_X86_OPERAND_IMMEDIATE
                && source_operand->bits == 8u) {
            pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                       | out->source[1];
            pl_u32 count = (pl_u32)source_operand->value.immediate & 0xffu;
            if (count > 32u) count = 32u;
            pl_u32 options = 2u
                           | (source->mnemonic == ZYDIS_MNEMONIC_PSLLD);
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 26u | ((pl_u64)fop << 16u)
                | ((pl_u64)(count & 7u) << 32u)
                | ((pl_u64)target->value.reg.index << 36u)
                | ((pl_u64)options << 40u)
                | ((pl_u64)(count >> 3u) << 44u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
            break;
        }
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->value.reg.index >= 8u
                || !((source_operand->kind == PL_X86_OPERAND_REGISTER
                      && source_operand->value.reg.class_id
                         == PL_X86_REGISTER_MMX
                      && source_operand->value.reg.index < 8u)
                     || (source_operand->kind == PL_X86_OPERAND_MEMORY
                         && source_operand->bits == 64u))) break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_PSLLD;
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 26u
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_MEMORY
                        ? 8u : 0u) << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)(source_operand->kind == PL_X86_OPERAND_REGISTER
                        ? source_operand->value.reg.index : 0u) << 32u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((pl_u64)options << 40u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_PSRLQ:
    case ZYDIS_MNEMONIC_PSLLQ: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *target = &out->operands[0];
        const pl_x86_operand *source_operand = &out->operands[1];
        if (target->kind == PL_X86_OPERAND_REGISTER
                && target->value.reg.class_id == PL_X86_REGISTER_VECTOR
                && target->bits == 128u && target->value.reg.index < 16u
                && source_operand->kind == PL_X86_OPERAND_IMMEDIATE
                && source_operand->bits == 8u) {
            pl_u32 target_index = target->value.reg.index;
            out->machine_operation = PL_X86_MACHINE_VECTOR;
            out->machine_argument =
                  (source->mnemonic == ZYDIS_MNEMONIC_PSRLQ ? 11u : 12u)
                | ((pl_u64)target_index << 8u)
                | ((pl_u64)target_index << 16u)
                | ((source_operand->value.immediate & 0xffu) << 32u);
            break;
        }
        if (target->kind != PL_X86_OPERAND_REGISTER
                || target->value.reg.class_id != PL_X86_REGISTER_MMX
                || target->value.reg.index >= 8u)
            break;
        pl_u32 fop = ((pl_u32)(out->source[0] & 7u) << 8u)
                   | out->source[1];
        pl_u32 options = source->mnemonic == ZYDIS_MNEMONIC_PSLLQ;
        pl_u32 source_index = 0u;
        pl_u32 variant = 0u;
        pl_u32 width = 0u;
        if (source_operand->kind == PL_X86_OPERAND_IMMEDIATE
                && source_operand->bits == 8u) {
            pl_u32 count = (pl_u32)source_operand->value.immediate & 0xffu;
            if (count > 64u) count = 64u;
            options |= 2u;
            source_index = count & 7u;
            variant = count >> 3u;
        } else if (source_operand->kind == PL_X86_OPERAND_REGISTER
                && source_operand->value.reg.class_id
                   == PL_X86_REGISTER_MMX
                && source_operand->value.reg.index < 8u) {
            source_index = source_operand->value.reg.index;
        } else if (source_operand->kind == PL_X86_OPERAND_MEMORY
                && source_operand->bits == 64u) {
            width = 8u;
        } else {
            break;
        }
        out->machine_operation = PL_X86_MACHINE_X87;
        out->machine_argument = 39u | ((pl_u64)width << 8u)
            | ((pl_u64)fop << 16u)
            | ((pl_u64)source_index << 32u)
            | ((pl_u64)target->value.reg.index << 36u)
            | ((pl_u64)options << 40u)
            | ((pl_u64)variant << 44u);
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
        break;
    }
    case ZYDIS_MNEMONIC_EMMS:
    case ZYDIS_MNEMONIC_FEMMS:
        if (!out->visible_operand_count) {
            out->machine_operation = PL_X86_MACHINE_X87;
            out->machine_argument = 41u;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_INSB:
    case ZYDIS_MNEMONIC_INSW:
    case ZYDIS_MNEMONIC_INSD:
    case ZYDIS_MNEMONIC_OUTSB:
    case ZYDIS_MNEMONIC_OUTSW:
    case ZYDIS_MNEMONIC_OUTSD: {
        int write = source->mnemonic == ZYDIS_MNEMONIC_OUTSB
                 || source->mnemonic == ZYDIS_MNEMONIC_OUTSW
                 || source->mnemonic == ZYDIS_MNEMONIC_OUTSD;
        pl_u32 width = source->mnemonic == ZYDIS_MNEMONIC_INSB
                    || source->mnemonic == ZYDIS_MNEMONIC_OUTSB ? 1u
                     : source->mnemonic == ZYDIS_MNEMONIC_INSW
                    || source->mnemonic == ZYDIS_MNEMONIC_OUTSW ? 2u : 4u;
        pl_u32 repeat = !!(source->attributes
            & (ZYDIS_ATTRIB_HAS_REP | ZYDIS_ATTRIB_HAS_REPE
               | ZYDIS_ATTRIB_HAS_REPNE));
        /* INS always addresses ES.  OUTS admits the decoded source override;
         * the normalized segment numbering is ES..GS == 0..5. */
        pl_u32 segment = write ? 3u : 0u;
        if (write)
            for (pl_u32 index = 0u; index < out->operand_count; ++index)
                if (out->operands[index].kind == PL_X86_OPERAND_MEMORY
                        && out->operands[index].value.memory.segment.class_id
                           == PL_X86_REGISTER_SEGMENT) {
                    segment = out->operands[index].value.memory.segment.index;
                    break;
                }
        if ((source->address_width == 16u || source->address_width == 32u
                    || source->address_width == 64u)
                && segment <= 5u) {
            out->machine_operation = PL_X86_MACHINE_PORT_IO;
            out->machine_argument = width | ((pl_u64)write << 8u)
                | (1ull << 9u)          /* DX is the port coordinate */
                | (1ull << 10u)         /* string transaction */
                | ((pl_u64)repeat << 11u)
                | ((pl_u64)source->address_width << 16u)
                | ((pl_u64)segment << 24u);
            out->flags|=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
            if(repeat)out->flags|=PL_X86_INSTRUCTION_REPEATED;
        }
        break;
    }
    case ZYDIS_MNEMONIC_XCHG:
    case ZYDIS_MNEMONIC_XADD:
    case ZYDIS_MNEMONIC_CMPXCHG: {
        if (out->visible_operand_count != 2u) break;
        const pl_x86_operand *memory = &out->operands[0];
        const pl_x86_operand *reg = &out->operands[1];
        if (memory->kind != PL_X86_OPERAND_MEMORY
                || reg->kind != PL_X86_OPERAND_REGISTER
                || reg->value.reg.class_id != PL_X86_REGISTER_GPR
                || reg->value.reg.index >= 16u
                || (reg->bits != 8u && reg->bits != 16u
                    && reg->bits != 32u && reg->bits != 64u))
            break;
        pl_u32 kind = source->mnemonic == ZYDIS_MNEMONIC_XCHG ? 0u
                    : source->mnemonic == ZYDIS_MNEMONIC_XADD ? 1u : 2u;
        /* Plain memory XADD already has a pure SSA transaction.  The machine
         * cut is required only when LOCK makes its publication indivisible. */
        if (kind == 1u && !(source->attributes & ZYDIS_ATTRIB_HAS_LOCK)) break;
        out->machine_operation = PL_X86_MACHINE_ATOMIC;
        out->machine_argument = kind | ((pl_u64)(reg->bits / 8u) << 8u)
            | ((pl_u64)reg->value.reg.index << 16u)
            | ((pl_u64)!!(reg->value.reg.flags & PL_X86_REGISTER_HIGH8)
               << 24u);
        break;
    }
    case ZYDIS_MNEMONIC_CMPXCHG8B:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && out->operands[0].bits == 64u) {
            out->machine_operation = PL_X86_MACHINE_ATOMIC;
            out->machine_argument = 13u | (8ull << 8u);
        }
        break;
    case ZYDIS_MNEMONIC_CMPXCHG16B:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY) {
            out->machine_operation = PL_X86_MACHINE_ATOMIC;
            out->machine_argument = 3u | (16ull << 8u);
        }
        break;
    case ZYDIS_MNEMONIC_NOT:
    case ZYDIS_MNEMONIC_NEG:
        if ((source->attributes & ZYDIS_ATTRIB_HAS_LOCK)
                && out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY
                && (out->operands[0].bits == 8u
                    || out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)) {
            out->machine_operation = PL_X86_MACHINE_ATOMIC;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_NOT ? 17u : 18u)
                | ((pl_u64)(out->operands[0].bits / 8u) << 8u);
        }
        break;
    case ZYDIS_MNEMONIC_POPF:
    case ZYDIS_MNEMONIC_POPFD:
    case ZYDIS_MNEMONIC_POPFQ:
        if (out->operand_width == 16u || out->operand_width == 64u) {
            out->machine_operation = PL_X86_MACHINE_POP_FLAGS;
            out->machine_argument = out->operand_width;
        }
        break;
    case ZYDIS_MNEMONIC_PUSH:
    case ZYDIS_MNEMONIC_POP:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_SEGMENT
                && (out->operands[0].value.reg.index == 4u
                    || out->operands[0].value.reg.index == 5u)
                && (out->operand_width == 16u
                    || out->operand_width == 64u)) {
            out->machine_operation = PL_X86_MACHINE_SEGMENT_STACK;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_POP)
                | ((pl_u64)out->operands[0].value.reg.index << 8u)
                | ((pl_u64)out->operand_width << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_RET:
        /* Zydis intentionally gives near and far returns one mnemonic.  The
         * opcode is the architectural distinction: CA/CB also consume CS and
         * may cross privilege, so accepting them as an ordinary near RET
         * silently loses descriptor state. */
        if (source->opcode == 0xcau || source->opcode == 0xcbu) {
            out->machine_operation = PL_X86_MACHINE_FAR_RETURN;
            out->machine_argument = 0u;
            if (source->opcode == 0xcau && out->visible_operand_count
                    && out->operands[0].kind == PL_X86_OPERAND_IMMEDIATE)
                out->machine_argument =
                    out->operands[0].value.immediate & 0xffffu;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_LFS:
    case ZYDIS_MNEMONIC_LGS:
    case ZYDIS_MNEMONIC_LSS:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && out->operands[0].value.reg.index < 16u
                && (out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && out->operands[1].kind == PL_X86_OPERAND_MEMORY
                && out->operands[1].bits
                   == out->operands[0].bits + 16u) {
            pl_u32 segment = source->mnemonic == ZYDIS_MNEMONIC_LFS ? 4u
                           : source->mnemonic == ZYDIS_MNEMONIC_LGS ? 5u
                           : 2u;
            out->machine_operation = PL_X86_MACHINE_WRITE_SEGMENT;
            out->machine_argument = segment | (1ull << 16u) | (1ull << 17u)
                | ((pl_u64)out->operands[0].value.reg.index << 24u)
                | ((pl_u64)out->operands[0].bits << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_MOV:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_CONTROL
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_GPR) {
            out->machine_operation = PL_X86_MACHINE_WRITE_CONTROL;
            out->machine_argument = out->operands[0].value.reg.index
                | ((pl_u64)out->operands[1].value.reg.index << 8u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_CONTROL) {
            out->machine_operation = PL_X86_MACHINE_READ_CONTROL;
            out->machine_argument = out->operands[1].value.reg.index
                | ((pl_u64)out->operands[0].value.reg.index << 8u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && ((out->operands[0].value.reg.class_id
                       == PL_X86_REGISTER_GPR
                     && out->operands[1].value.reg.class_id
                       == PL_X86_REGISTER_DEBUG)
                    || (out->operands[0].value.reg.class_id
                          == PL_X86_REGISTER_DEBUG
                        && out->operands[1].value.reg.class_id
                          == PL_X86_REGISTER_GPR))) {
            pl_u32 write = out->operands[0].value.reg.class_id
                         == PL_X86_REGISTER_DEBUG;
            pl_u32 debug = out->operands[write ? 0u : 1u].value.reg.index;
            pl_u32 reg = out->operands[write ? 1u : 0u].value.reg.index;
            if (debug >= 8u || reg >= 16u) break;
            out->machine_operation = PL_X86_MACHINE_DEBUG_REGISTER;
            out->machine_argument = write
                | ((pl_u64)debug << 8u) | ((pl_u64)reg << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_SEGMENT
                && (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                    || (out->operands[1].kind == PL_X86_OPERAND_REGISTER
                        && out->operands[1].value.reg.class_id
                           == PL_X86_REGISTER_GPR))) {
            pl_u32 memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 source_register = memory
                ? 0u : out->operands[1].value.reg.index;
            out->machine_operation = PL_X86_MACHINE_WRITE_SEGMENT;
            out->machine_argument = out->operands[0].value.reg.index
                | ((pl_u64)source_register << 8u)
                | ((pl_u64)memory << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        } else if (out->visible_operand_count == 2u
                && (out->operands[0].kind == PL_X86_OPERAND_REGISTER
                    || out->operands[0].kind == PL_X86_OPERAND_MEMORY)
                && (out->operands[0].kind != PL_X86_OPERAND_REGISTER
                    || out->operands[0].value.reg.class_id
                       == PL_X86_REGISTER_GPR)
                && out->operands[1].kind == PL_X86_OPERAND_REGISTER
                && out->operands[1].value.reg.class_id
                   == PL_X86_REGISTER_SEGMENT
                && out->operands[1].value.reg.index <= 5u
                && (out->operands[0].kind == PL_X86_OPERAND_MEMORY
                    ? out->operands[0].bits == 16u
                    : (out->operands[0].bits == 16u
                       || out->operands[0].bits == 32u
                       || out->operands[0].bits == 64u))) {
            pl_u32 memory = out->operands[0].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 target = memory ? 0u : out->operands[0].value.reg.index;
            out->machine_operation = PL_X86_MACHINE_READ_SELECTOR;
            out->machine_argument = out->operands[1].value.reg.index
                | ((pl_u64)memory << 8u) | ((pl_u64)target << 16u)
                | ((pl_u64)out->operands[0].bits << 24u);
            out->flags |= PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_SLDT:
    case ZYDIS_MNEMONIC_STR:
        if (out->visible_operand_count == 1u
                && (out->operands[0].kind == PL_X86_OPERAND_REGISTER
                    || out->operands[0].kind == PL_X86_OPERAND_MEMORY)
                && (out->operands[0].kind != PL_X86_OPERAND_REGISTER
                    || out->operands[0].value.reg.class_id
                       == PL_X86_REGISTER_GPR)
                && (out->operands[0].kind == PL_X86_OPERAND_MEMORY
                    ? out->operands[0].bits == 16u
                    : (out->operands[0].bits == 16u
                       || out->operands[0].bits == 32u
                       || out->operands[0].bits == 64u))) {
            pl_u32 memory = out->operands[0].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 target = memory ? 0u : out->operands[0].value.reg.index;
            pl_u32 selector = source->mnemonic == ZYDIS_MNEMONIC_SLDT
                            ? 6u : 7u;
            out->machine_operation = PL_X86_MACHINE_READ_SELECTOR;
            out->machine_argument = selector | ((pl_u64)memory << 8u)
                | ((pl_u64)target << 16u)
                | ((pl_u64)out->operands[0].bits << 24u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_LAR:
    case ZYDIS_MNEMONIC_LSL:
        if (out->visible_operand_count == 2u
                && out->operands[0].kind == PL_X86_OPERAND_REGISTER
                && out->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && out->operands[0].value.reg.index < 16u
                && (out->operands[0].bits == 16u
                    || out->operands[0].bits == 32u
                    || out->operands[0].bits == 64u)
                && (out->operands[1].kind == PL_X86_OPERAND_MEMORY
                    || (out->operands[1].kind == PL_X86_OPERAND_REGISTER
                        && out->operands[1].value.reg.class_id
                           == PL_X86_REGISTER_GPR
                        && out->operands[1].value.reg.index < 16u))) {
            pl_u32 memory = out->operands[1].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_SYSTEM_SELECTOR;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_LSL)
                | ((pl_u64)memory << 8u)
                | ((pl_u64)(memory
                    ? 0u : out->operands[1].value.reg.index) << 16u)
                | ((pl_u64)out->operands[0].value.reg.index << 24u)
                | ((pl_u64)out->operands[0].bits << 32u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_LLDT:
    case ZYDIS_MNEMONIC_LTR:
        if (out->visible_operand_count == 1u
                && (out->operands[0].kind == PL_X86_OPERAND_MEMORY
                    || (out->operands[0].kind == PL_X86_OPERAND_REGISTER
                        && out->operands[0].value.reg.class_id
                           == PL_X86_REGISTER_GPR
                        && out->operands[0].value.reg.index < 16u))) {
            pl_u32 memory = out->operands[0].kind == PL_X86_OPERAND_MEMORY;
            out->machine_operation = PL_X86_MACHINE_SYSTEM_SELECTOR;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_LLDT ? 2u : 3u)
                | ((pl_u64)memory << 8u)
                | ((pl_u64)(memory
                    ? 0u : out->operands[0].value.reg.index) << 16u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_VERR:
    case ZYDIS_MNEMONIC_VERW:
        if (out->visible_operand_count == 1u
                && (out->operands[0].kind == PL_X86_OPERAND_REGISTER
                    || out->operands[0].kind == PL_X86_OPERAND_MEMORY)
                && (out->operands[0].kind != PL_X86_OPERAND_REGISTER
                    || (out->operands[0].value.reg.class_id
                        == PL_X86_REGISTER_GPR
                        && out->operands[0].value.reg.index < 16u))
                && out->operands[0].bits == 16u) {
            pl_u32 memory = out->operands[0].kind == PL_X86_OPERAND_MEMORY;
            pl_u32 source_register = memory
                                   ? 0u : out->operands[0].value.reg.index;
            out->machine_operation = PL_X86_MACHINE_VALIDATE_SELECTOR;
            out->machine_argument =
                (source->mnemonic == ZYDIS_MNEMONIC_VERW)
                | ((pl_u64)memory << 1u)
                | ((pl_u64)source_register << 8u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    case ZYDIS_MNEMONIC_LGDT:
    case ZYDIS_MNEMONIC_LIDT:
    case ZYDIS_MNEMONIC_SGDT:
    case ZYDIS_MNEMONIC_SIDT:
        if (out->visible_operand_count == 1u
                && out->operands[0].kind == PL_X86_OPERAND_MEMORY) {
            pl_u32 idtr = source->mnemonic == ZYDIS_MNEMONIC_LIDT
                       || source->mnemonic == ZYDIS_MNEMONIC_SIDT;
            pl_u32 store = source->mnemonic == ZYDIS_MNEMONIC_SGDT
                        || source->mnemonic == ZYDIS_MNEMONIC_SIDT;
            out->machine_operation = PL_X86_MACHINE_DESCRIPTOR_TABLE;
            out->machine_argument = idtr | ((pl_u64)store << 1u);
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                        | PL_X86_INSTRUCTION_PRECISE_CUT
                        | PL_X86_INSTRUCTION_BARRIER;
        }
        break;
    default:
        break;
    }
}

static void classify_operands(const ZydisDecodedOperand *operands,
                              pl_x86_instruction *out)
{
    for (pl_u32 index = 0u; index < out->operand_count; ++index) {
        normalize_operand(&operands[index], &out->operands[index]);
        const pl_x86_operand *operand = &out->operands[index];
        if (operand->kind == PL_X86_OPERAND_MEMORY
                && !(operand->flags & PL_X86_OPERAND_ADDRESS_ONLY)) {
            if (operand->flags & (PL_X86_OPERAND_READ
                                | PL_X86_OPERAND_CONDITIONAL_READ))
                out->flags |= PL_X86_INSTRUCTION_READS_MEMORY;
            if (operand->flags & (PL_X86_OPERAND_WRITE
                                | PL_X86_OPERAND_CONDITIONAL_WRITE))
                out->flags |= PL_X86_INSTRUCTION_WRITES_MEMORY;
            out->flags |= PL_X86_INSTRUCTION_MAY_TRAP;
        }
        if ((out->flow == PL_X86_FLOW_CONDITIONAL
                    || out->flow == PL_X86_FLOW_JUMP
                    || out->flow == PL_X86_FLOW_CALL)
                && operand->kind == PL_X86_OPERAND_IMMEDIATE
                && (operand->flags & PL_X86_OPERAND_RELATIVE)) {
            out->target = out->fallthrough + operand->value.immediate;
            out->flags |= PL_X86_INSTRUCTION_DIRECT_TARGET;
        }
    }
    if ((out->flow == PL_X86_FLOW_JUMP || out->flow == PL_X86_FLOW_CALL)
            && !(out->flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
        out->flags |= PL_X86_INSTRUCTION_INDIRECT;
}

/* These transfers are valid x86 instructions, but their observable state is
 * larger than the GPR/RFLAGS SSA frame.  Naming them as machine barriers here
 * prevents a grammar miss from masquerading as a request for scalar
 * interpretation.  The barrier ABI owns descriptor state and atomic memory;
 * ordinary FS/GS-addressed loads stay in the pure semantic path. */
static void classify_architectural_barriers(pl_x86_instruction *out)
{
    int external_register = 0;
    int memory_operand = 0;
    int far_control = 0;
    for (pl_u32 index = 0u; index < out->operand_count; ++index) {
        const pl_x86_operand *operand = &out->operands[index];
        external_register |= operand->kind == PL_X86_OPERAND_REGISTER
                          && operand->value.reg.class_id
                             != PL_X86_REGISTER_GPR
                          && operand->value.reg.class_id
                             != PL_X86_REGISTER_FLAGS
                          && operand->value.reg.class_id
                             != PL_X86_REGISTER_IP;
        memory_operand |= operand->kind == PL_X86_OPERAND_MEMORY
                       && !(operand->flags & PL_X86_OPERAND_ADDRESS_ONLY);
        far_control |= (out->flow == PL_X86_FLOW_CALL
                     || out->flow == PL_X86_FLOW_JUMP)
                    && (operand->kind == PL_X86_OPERAND_POINTER
                     || (operand->kind == PL_X86_OPERAND_MEMORY
                         && operand->bits != 64u));
    }
    if ((external_register
            && out->operation != PL_X86_OPERATION_BASE_ACCESS) || far_control
            || (out->flags & PL_X86_INSTRUCTION_LOCKED)) {
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
    }
    /* XCHG with memory is implicitly locked even without a LOCK prefix. */
    if (out->operation == PL_X86_OPERATION_EXCHANGE && memory_operand) {
        out->flags |= PL_X86_INSTRUCTION_LOCKED
                    | PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
    }
    /* A failed memory CMPXCHG still performs a write-access cycle.  Keep that
     * access at the machine boundary until the direct memory transaction can
     * publish both the predicate and the unconditional write permission cut. */
    if (out->operation == PL_X86_OPERATION_COMPARE_EXCHANGE
            && memory_operand) {
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT
                    | PL_X86_INSTRUCTION_BARRIER;
    }
    /* POP r/m is not a machine escape: its destination EA substitutes the
     * post-increment RSP and remains an ordered load/store SSA transaction. */
}

static int decode_validated(const pl_x86_image *image, pl_u64 rip,
                            pl_x86_instruction *out, int fixed_profile)
{
    zero_bytes(out, sizeof *out);
    out->rip = rip;
    pl_u8 bytes[PL_X86_MAX_INSTRUCTION_BYTES];
    pl_u32 available = 0u;
    int status = image_read_validated(
        image, rip, bytes, sizeof bytes, &available);
    if (status) return status;
    out->source_bytes = (pl_u8)available;
    for (pl_u32 index = 0u; index < available; ++index)
        out->source[index] = bytes[index];
    if (!available) {
        set_fault(out, PL_X86_DECODE_FETCH_FAULT, 14u);
        return 0;
    }

    /* VIA PadLock XSHA512 is F3 0F A6 E0.  It is outside the fixed
     * x86-64-v2 CPU contract and therefore has the exact #UD future for an
     * accepted program.  Some decoder releases do not know this last member
     * of the PadLock hash family; treating all available bytes as one invalid
     * instruction would move the precise cut eleven bytes too far. */
    if (available >= 4u && bytes[0] == 0xf3u && bytes[1] == 0x0fu
            && bytes[2] == 0xa6u && bytes[3] == 0xe0u) {
        out->source_bytes = 4u;
        out->fallthrough = rip + 4u;
        out->length = 4u;
        set_fault(out, PL_X86_DECODE_VALID, 6u);
        return 0;
    }

    /* LKGS r/m16 is F2 0F 00 /6.  Linux 7.1 emits the register spelling as
     * raw bytes while common decoder releases still predate the instruction.
     * The shipped form uses DI; unlike MOV GS, LKGS loads the descriptor base
     * into IA32_KERNEL_GS_BASE and leaves the active GS base unchanged. */
    if (available >= 4u && bytes[0] == 0xf2u && bytes[1] == 0x0fu
            && bytes[2] == 0x00u && bytes[3] == 0xf7u) {
        out->status = PL_X86_DECODE_VALID;
        out->flow = PL_X86_FLOW_NEXT;
        out->family = PL_X86_FAMILY_GENERAL;
        out->operation = PL_X86_OPERATION_UNSUPPORTED;
        out->condition = 0xffu;
        out->length = 4u;
        out->source_bytes = 4u;
        out->fallthrough = rip + 4u;
        out->flags = PL_X86_INSTRUCTION_FALLTHROUGH
                   | PL_X86_INSTRUCTION_MAY_TRAP
                   | PL_X86_INSTRUCTION_PRECISE_CUT
                   | PL_X86_INSTRUCTION_PRIVILEGED
                   | PL_X86_INSTRUCTION_BARRIER;
        out->operand_width = 16u;
        out->address_width = 64u;
        out->operand_count = 1u;
        out->visible_operand_count = 1u;
        out->operands[0].kind = PL_X86_OPERAND_REGISTER;
        out->operands[0].bits = 16u;
        out->operands[0].flags =
            PL_X86_OPERAND_READ | PL_X86_OPERAND_EXPLICIT;
        out->operands[0].value.reg.class_id = PL_X86_REGISTER_GPR;
        out->operands[0].value.reg.index = 7u;
        out->operands[0].value.reg.bits = 16u;
        out->machine_operation = PL_X86_MACHINE_LOAD_KERNEL_GS;
        out->machine_argument = 7u;
        return 0;
    }

    ZydisDecoder decoder;
    ZydisDecodedInstruction instruction;
    ZydisDecodedOperand operands[ZYDIS_MAX_OPERAND_COUNT];
    ZyanStatus decoded = ZydisDecoderInit(
        &decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
    if (!ZYAN_SUCCESS(decoded)) return PL_ERROR_X86;
    if (fixed_profile) {
        /* These prefixes reuse legacy scans rather than faulting when their
         * extension is absent. Bind before operand/flag classification, not
         * by relabeling a count row after its semantics were decoded. */
        if (!ZYAN_SUCCESS(ZydisDecoderEnableMode(&decoder,ZYDIS_DECODER_MODE_TZCNT,
                PL_X86_CPUID_7_0_EBX&(1u<<3u) ? ZYAN_TRUE : ZYAN_FALSE))
                || !ZYAN_SUCCESS(ZydisDecoderEnableMode(&decoder,ZYDIS_DECODER_MODE_LZCNT,
                    PL_X86_CPUID_80000001_ECX&(1u<<5u) ? ZYAN_TRUE : ZYAN_FALSE)))
            return PL_ERROR_X86;
    }
    decoded = ZydisDecoderDecodeFull(
        &decoder, bytes, available, &instruction, operands);
    if (!ZYAN_SUCCESS(decoded)) {
        if (decoded == ZYDIS_STATUS_NO_MORE_DATA)
            set_fault(out, PL_X86_DECODE_FETCH_FAULT, 14u);
        else if (decoded == ZYDIS_STATUS_INSTRUCTION_TOO_LONG)
            set_fault(out, PL_X86_DECODE_TOO_LONG, 13u);
        else
            set_fault(out, PL_X86_DECODE_INVALID, 6u);
        if(out->status!=PL_X86_DECODE_FETCH_FAULT){
            /* A fault proof owns only the decisive fetched prefix. Keeping
             * all fifteen available bytes could force an unrelated next-page
             * fetch ahead of an already determined #UD. Do not replace a
             * NO_MORE_DATA prefix by a guessed architectural exception. */
            pl_u32 needed=available;
            for(pl_u32 prefix=1u;prefix<available;++prefix){
                ZyanStatus probe=ZydisDecoderDecodeFull(&decoder,bytes,prefix,&instruction,operands);
                if(!ZYAN_SUCCESS(probe) && probe!=ZYDIS_STATUS_NO_MORE_DATA){needed=prefix;break;}
            }
            out->length=(pl_u8)needed;out->source_bytes=(pl_u8)needed;out->fallthrough=rip+needed;
        }
        return 0;
    }

    out->status = PL_X86_DECODE_VALID;
    out->flow = PL_X86_FLOW_NEXT;
    out->family = PL_X86_FAMILY_GENERAL;
    out->operation = PL_X86_OPERATION_UNSUPPORTED;
    out->condition = 0xffu;
    out->length = instruction.length;
    out->source_bytes = instruction.length;
    out->fallthrough = rip + instruction.length;
    out->flags = PL_X86_INSTRUCTION_FALLTHROUGH;
    out->operand_width = instruction.operand_width;
    out->address_width = instruction.address_width;
    out->encoding = (pl_u8)instruction.encoding;
    out->opcode_map = (pl_u8)instruction.opcode_map;
    out->opcode = instruction.opcode;
    out->operand_count = instruction.operand_count;
    out->visible_operand_count = instruction.operand_count_visible;
    out->displacement_offset = instruction.raw.disp.offset;
    out->displacement_bytes = (pl_u8)(instruction.raw.disp.size / 8u);
    for (pl_u32 index = 0u; index < 2u; ++index) {
        out->immediate_offset[index] = instruction.raw.imm[index].offset;
        out->immediate_bytes[index] =
            (pl_u8)(instruction.raw.imm[index].size / 8u);
    }
    if (out->operand_count > PL_X86_MAX_OPERANDS) return PL_ERROR_X86;
    if (instruction.attributes & ZYDIS_ATTRIB_HAS_LOCK)
        out->flags |= PL_X86_INSTRUCTION_LOCKED
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
    if (instruction.attributes & ZYDIS_ATTRIB_IS_PRIVILEGED)
        out->flags |= PL_X86_INSTRUCTION_PRIVILEGED
                    | PL_X86_INSTRUCTION_MAY_TRAP;
    if (instruction.meta.exception_class != ZYDIS_EXCEPTION_CLASS_NONE)
        out->flags |= PL_X86_INSTRUCTION_MAY_TRAP;
    classify_control(&instruction, out);
    classify_mnemonic(&instruction, out);
    if (out->operation == PL_X86_OPERATION_STRING
            && (instruction.attributes
                & (ZYDIS_ATTRIB_HAS_REP
                   | ZYDIS_ATTRIB_HAS_REPE
                   | ZYDIS_ATTRIB_HAS_REPNE))) {
        out->flags |= PL_X86_INSTRUCTION_REPEATED
                    | PL_X86_INSTRUCTION_MAY_TRAP
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
        if (instruction.attributes & ZYDIS_ATTRIB_HAS_REPNE)
            out->flags |= PL_X86_INSTRUCTION_REPEAT_WHILE_NOT_EQUAL;
        /* STOS is one physical MEMORY_REPEAT transaction.  Every other REP
         * family becomes one typed residual state-step after its implicit
         * operands are normalized below. */
        if (out->condition != 1u)
            out->flags |= PL_X86_INSTRUCTION_BARRIER;
    }
    classify_operands(operands, out);
    classify_machine_operation(&instruction, out);
    if (outside_delivery_profile(instruction.meta.isa_set)
            && instruction.mnemonic != ZYDIS_MNEMONIC_ENDBR32
            && instruction.mnemonic != ZYDIS_MNEMONIC_ENDBR64
            && !fixed_profile && (out->flow == PL_X86_FLOW_NEXT
                || out->flow == PL_X86_FLOW_SYSTEM)) {
        out->machine_operation = PL_X86_MACHINE_EXTENSION;
        out->machine_argument = 0u;
        out->flags |= PL_X86_INSTRUCTION_BARRIER
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
    } else if ((outside_delivery_profile(instruction.meta.isa_set)
                && instruction.mnemonic != ZYDIS_MNEMONIC_ENDBR32
                && instruction.mnemonic != ZYDIS_MNEMONIC_ENDBR64)
            || instruction.mnemonic == ZYDIS_MNEMONIC_RSM) {
        set_fault(out, PL_X86_DECODE_VALID, 6u);
        out->machine_operation = PL_X86_MACHINE_NONE;
        out->machine_argument = 0u;
    }
    if (out->operation == PL_X86_OPERATION_UNSUPPORTED
            && out->machine_operation == PL_X86_MACHINE_NONE
            && (out->flow == PL_X86_FLOW_NEXT
                || out->flow == PL_X86_FLOW_SYSTEM)) {
        out->machine_operation = PL_X86_MACHINE_EXTENSION;
        out->flags |= PL_X86_INSTRUCTION_BARRIER
                    | PL_X86_INSTRUCTION_PRECISE_CUT;
    }
    /* NOP-family addressing forms and prefetch hints neither dereference nor
     * fault on their address.  Do not manufacture a memory cut merely because
     * the decoder exposes the ModRM address as an operand. */
    if (out->operation == PL_X86_OPERATION_NOP)
        out->flags &= ~(PL_X86_INSTRUCTION_READS_MEMORY
                      | PL_X86_INSTRUCTION_WRITES_MEMORY
                      | PL_X86_INSTRUCTION_MAY_TRAP);
    classify_architectural_barriers(out);
    return 0;
}

int pl_x86_decode(const pl_x86_image *image, pl_u64 rip,
                  pl_x86_instruction *out)
{
    if (!image || !out) return PL_ERROR_X86;
    int status = pl_x86_image_validate(image);
    return status ? status : decode_validated(image, rip, out, 0);
}

int pl_x86_decode_profile(const pl_x86_image *image, pl_u64 rip,
                          pl_x86_instruction *out)
{
    if (!image || !out) return PL_ERROR_X86;
    int status=pl_x86_image_validate(image);
    return status ? status : decode_validated(image,rip,out,1);
}

int pl_x86_frontend_open(const pl_x86_image *image,
                         pl_x86_frontend *out)
{
    if (!out) return PL_ERROR_X86;
    int status = pl_x86_image_validate(image);
    if (status) return status;
    out->image = image;
    for (pl_u32 slot = 0u; slot < PL_X86_FRONTEND_CACHE_ENTRIES; ++slot)
        out->cache_valid[slot] = 0u;
    return 0;
}

int pl_x86_frontend_contains(const pl_x86_frontend *frontend,
                             pl_u64 address)
{
    return frontend && frontend->image
        && find_map(frontend->image, address) < frontend->image->map_count;
}

int pl_x86_frontend_decode(const pl_x86_frontend *frontend, pl_u64 rip,
                           pl_x86_instruction *out)
{
    if (!frontend || !frontend->image || !out) return PL_ERROR_X86;
    pl_x86_frontend *cache = (pl_x86_frontend *)frontend;
    pl_u32 slot = (pl_u32)(rip & (PL_X86_FRONTEND_CACHE_ENTRIES - 1u));
    if (cache->cache_valid[slot] && cache->cache_rip[slot] == rip) {
        *out = cache->cache_instruction[slot];
        return 0;
    }
    int status = decode_validated(frontend->image, rip, out, 0);
    cache->cache_rip[slot] = rip;
    cache->cache_instruction[slot] = *out;
    cache->cache_valid[slot] = 1u;
    return status;
}

static int same_register(const pl_x86_register *left,
                         const pl_x86_register *right)
{
    return left->class_id == right->class_id
        && left->index == right->index
        && left->bits == right->bits
        && left->flags == right->flags;
}

static int same_operand(const pl_x86_operand *left,
                        const pl_x86_operand *right)
{
    if (left->kind != right->kind || left->bits != right->bits
            || left->flags != right->flags)
        return 0;
    switch (left->kind) {
    case PL_X86_OPERAND_REGISTER:
        return same_register(&left->value.reg, &right->value.reg);
    case PL_X86_OPERAND_MEMORY:
        return same_register(
                   &left->value.memory.segment,
                   &right->value.memory.segment)
            && same_register(
                   &left->value.memory.base,
                   &right->value.memory.base)
            && same_register(
                   &left->value.memory.index,
                   &right->value.memory.index)
            && left->value.memory.displacement
                == right->value.memory.displacement
            && left->value.memory.scale == right->value.memory.scale
            && left->value.memory.has_displacement
                == right->value.memory.has_displacement;
    case PL_X86_OPERAND_IMMEDIATE:
        return left->value.immediate == right->value.immediate;
    case PL_X86_OPERAND_POINTER:
        return left->value.pointer.segment == right->value.pointer.segment
            && left->value.pointer.offset == right->value.pointer.offset;
    default:
        return 1;
    }
}

int pl_x86_transfer_equal(const pl_x86_instruction *left,
                          const pl_x86_instruction *right)
{
    if (!left || !right) return 0;
    if (left->flow == PL_X86_FLOW_FAULT
            || right->flow == PL_X86_FLOW_FAULT)
        return left->flow == PL_X86_FLOW_FAULT
            && right->flow == PL_X86_FLOW_FAULT
            && left->trap_vector == right->trap_vector;
    if (left->flags != right->flags
            || left->operand_width != right->operand_width
            || left->address_width != right->address_width
            || left->length != right->length
            || left->status != right->status
            || left->flow != right->flow
            || left->family != right->family
            || left->encoding != right->encoding
            || left->opcode_map != right->opcode_map
            || left->opcode != right->opcode
            || left->trap_vector != right->trap_vector
            || left->operand_count != right->operand_count
            || left->visible_operand_count != right->visible_operand_count
            || left->source_bytes != right->source_bytes
            || left->operation != right->operation
            || left->condition != right->condition
            || left->machine_operation != right->machine_operation
            || left->machine_argument != right->machine_argument)
        return 0;
    for (pl_u32 index = 0u; index < left->source_bytes; ++index)
        if (left->source[index] != right->source[index]) return 0;
    for (pl_u32 index = 0u; index < left->operand_count; ++index)
        if (!same_operand(&left->operands[index], &right->operands[index]))
            return 0;
    return 1;
}

typedef struct {
    pl_u8 *target;
    pl_u32 capacity;
    pl_u32 used;
    int status;
} transfer_spelling_writer;

static void transfer_put_u8(transfer_spelling_writer *writer, pl_u32 value)
{
    if (writer->status) return;
    if (writer->used == 0xffffffffu
            || (writer->target && writer->used >= writer->capacity)) {
        writer->status = PL_ERROR_X86;
        return;
    }
    if (writer->target) writer->target[writer->used] = (pl_u8)value;
    ++writer->used;
}

static void transfer_put_u16(transfer_spelling_writer *writer, pl_u32 value)
{
    transfer_put_u8(writer, value);
    transfer_put_u8(writer, value >> 8u);
}

static void transfer_put_u32(transfer_spelling_writer *writer, pl_u32 value)
{
    transfer_put_u16(writer, value);
    transfer_put_u16(writer, value >> 16u);
}

static void transfer_put_u64(transfer_spelling_writer *writer, pl_u64 value)
{
    transfer_put_u32(writer, (pl_u32)value);
    transfer_put_u32(writer, (pl_u32)(value >> 32u));
}

static void transfer_put_register(transfer_spelling_writer *writer,
                                  const pl_x86_register *reg)
{
    transfer_put_u8(writer, reg->class_id);
    transfer_put_u8(writer, reg->index);
    transfer_put_u16(writer, reg->bits);
    transfer_put_u32(writer, reg->flags);
}

static void transfer_put_operand(transfer_spelling_writer *writer,
                                 const pl_x86_operand *operand)
{
    transfer_put_u8(writer, operand->kind);
    transfer_put_u16(writer, operand->bits);
    transfer_put_u32(writer, operand->flags);
    switch (operand->kind) {
    case PL_X86_OPERAND_REGISTER:
        transfer_put_register(writer, &operand->value.reg);
        break;
    case PL_X86_OPERAND_MEMORY:
        transfer_put_register(writer, &operand->value.memory.segment);
        transfer_put_register(writer, &operand->value.memory.base);
        transfer_put_register(writer, &operand->value.memory.index);
        transfer_put_u64(
            writer, (pl_u64)operand->value.memory.displacement);
        transfer_put_u8(writer, operand->value.memory.scale);
        transfer_put_u8(writer, operand->value.memory.has_displacement);
        break;
    case PL_X86_OPERAND_IMMEDIATE:
        transfer_put_u64(writer, operand->value.immediate);
        break;
    case PL_X86_OPERAND_POINTER:
        transfer_put_u16(writer, operand->value.pointer.segment);
        transfer_put_u32(writer, operand->value.pointer.offset);
        break;
    default:
        break;
    }
}

static int transfer_spelling(const pl_x86_instruction *instruction,
                             pl_u8 *target, pl_u32 capacity,
                             pl_u32 *written)
{
    if (!instruction || !written) return PL_ERROR_X86;
    transfer_spelling_writer writer = {
        target, capacity, 0u, 0,
    };
    transfer_put_u8(&writer, 'X');
    transfer_put_u8(&writer, '8');
    transfer_put_u8(&writer, '6');
    transfer_put_u8(&writer, 'T');
    transfer_put_u8(&writer, 1u);
    if (instruction->flow == PL_X86_FLOW_FAULT) {
        transfer_put_u8(&writer, PL_X86_FLOW_FAULT);
        transfer_put_u8(&writer, instruction->trap_vector);
    } else {
        if (instruction->operand_count > PL_X86_MAX_OPERANDS
                || instruction->source_bytes > PL_X86_MAX_INSTRUCTION_BYTES)
            return PL_ERROR_X86;
        transfer_put_u32(&writer, instruction->flags);
        transfer_put_u16(&writer, instruction->operand_width);
        transfer_put_u16(&writer, instruction->address_width);
        transfer_put_u8(&writer, instruction->length);
        transfer_put_u8(&writer, instruction->status);
        transfer_put_u8(&writer, instruction->flow);
        transfer_put_u8(&writer, instruction->family);
        transfer_put_u8(&writer, instruction->encoding);
        transfer_put_u8(&writer, instruction->opcode_map);
        transfer_put_u8(&writer, instruction->opcode);
        transfer_put_u8(&writer, instruction->trap_vector);
        transfer_put_u8(&writer, instruction->operand_count);
        transfer_put_u8(&writer, instruction->visible_operand_count);
        transfer_put_u8(&writer, instruction->source_bytes);
        transfer_put_u8(&writer, instruction->operation);
        transfer_put_u8(&writer, instruction->condition);
        transfer_put_u8(&writer, instruction->machine_operation);
        transfer_put_u64(&writer, instruction->machine_argument);
        for (pl_u32 index = 0u; index < instruction->source_bytes; ++index)
            transfer_put_u8(&writer, instruction->source[index]);
        for (pl_u32 index = 0u; index < instruction->operand_count; ++index)
            transfer_put_operand(&writer, &instruction->operands[index]);
    }
    if (writer.status) return writer.status;
    *written = writer.used;
    return 0;
}

int pl_x86_transfer_measure(const pl_x86_instruction *instruction,
                            pl_u32 *bytes)
{
    return transfer_spelling(instruction, 0, 0u, bytes);
}

int pl_x86_transfer_write(const pl_x86_instruction *instruction,
                          pl_u8 *target, pl_u32 capacity,
                          pl_u32 *written)
{
    if (!target) return PL_ERROR_X86;
    return transfer_spelling(instruction, target, capacity, written);
}

static pl_u64 transfer_mix(pl_u64 hash, pl_u64 value)
{
    return hash ^ (value + 0x9e3779b97f4a7c15ull
                 + (hash << 6u) + (hash >> 2u));
}

static pl_u64 hash_register(pl_u64 hash, const pl_x86_register *reg)
{
    hash = transfer_mix(hash, reg->class_id);
    hash = transfer_mix(hash, reg->index);
    hash = transfer_mix(hash, reg->bits);
    return transfer_mix(hash, reg->flags);
}

static pl_u64 hash_operand(pl_u64 hash, const pl_x86_operand *operand)
{
    hash = transfer_mix(hash, operand->kind);
    hash = transfer_mix(hash, operand->bits);
    hash = transfer_mix(hash, operand->flags);
    switch (operand->kind) {
    case PL_X86_OPERAND_REGISTER:
        return hash_register(hash, &operand->value.reg);
    case PL_X86_OPERAND_MEMORY:
        hash = hash_register(hash, &operand->value.memory.segment);
        hash = hash_register(hash, &operand->value.memory.base);
        hash = hash_register(hash, &operand->value.memory.index);
        hash = transfer_mix(
            hash, (pl_u64)operand->value.memory.displacement);
        hash = transfer_mix(hash, operand->value.memory.scale);
        return transfer_mix(
            hash, operand->value.memory.has_displacement);
    case PL_X86_OPERAND_IMMEDIATE:
        return transfer_mix(hash, operand->value.immediate);
    case PL_X86_OPERAND_POINTER:
        hash = transfer_mix(hash, operand->value.pointer.segment);
        return transfer_mix(hash, operand->value.pointer.offset);
    default:
        return hash;
    }
}

pl_u64 pl_x86_transfer_hash(const pl_x86_instruction *instruction)
{
    if (!instruction) return 0u;
    pl_u64 hash = 0xcbf29ce484222325ull;
    if (instruction->flow == PL_X86_FLOW_FAULT) {
        hash = transfer_mix(hash, PL_X86_FLOW_FAULT);
        return transfer_mix(hash, instruction->trap_vector);
    }
    hash = transfer_mix(hash, instruction->flags);
    hash = transfer_mix(hash, instruction->operand_width);
    hash = transfer_mix(hash, instruction->address_width);
    hash = transfer_mix(hash, instruction->length);
    hash = transfer_mix(hash, instruction->status);
    hash = transfer_mix(hash, instruction->flow);
    hash = transfer_mix(hash, instruction->family);
    hash = transfer_mix(hash, instruction->encoding);
    hash = transfer_mix(hash, instruction->opcode_map);
    hash = transfer_mix(hash, instruction->opcode);
    hash = transfer_mix(hash, instruction->trap_vector);
    hash = transfer_mix(hash, instruction->operand_count);
    hash = transfer_mix(hash, instruction->visible_operand_count);
    hash = transfer_mix(hash, instruction->source_bytes);
    hash = transfer_mix(hash, instruction->operation);
    hash = transfer_mix(hash, instruction->condition);
    hash = transfer_mix(hash, instruction->machine_operation);
    hash = transfer_mix(hash, instruction->machine_argument);
    for (pl_u32 index = 0u; index < instruction->source_bytes; ++index)
        hash = transfer_mix(hash, instruction->source[index]);
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index)
        hash = hash_operand(hash, &instruction->operands[index]);
    return hash;
}

static int catalog(const pl_x86_image *image,pl_x86_visit visit,
    void *context,pl_x86_catalog *out,int fixed_profile)
{
    if (!image || !out) return PL_ERROR_X86;
    int status = pl_x86_image_validate(image);
    if (status) return status;
    zero_bytes(out, sizeof *out);
    for (pl_u32 map_index = 0u; map_index < image->map_count; ++map_index) {
        const pl_x86_map *map = &image->maps[map_index];
        for (pl_u64 offset = 0u; offset < map->memory_bytes; ++offset) {
            pl_x86_instruction instruction;
            status = decode_validated(
                image, map->address + offset, &instruction, fixed_profile);
            if (status) return status;
            ++out->coordinates;
            switch (instruction.status) {
            case PL_X86_DECODE_VALID: ++out->decoded; break;
            case PL_X86_DECODE_INVALID: ++out->invalid; break;
            case PL_X86_DECODE_TOO_LONG: ++out->overlong; break;
            case PL_X86_DECODE_FETCH_FAULT: ++out->fetch_faults; break;
            default: return PL_ERROR_X86;
            }
            if (instruction.flow == PL_X86_FLOW_FAULT)
                ++out->fault_functions;
            if (instruction.flags & PL_X86_INSTRUCTION_PRECISE_CUT)
                ++out->precise_cuts;
            if (instruction.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            {
                ++out->direct_edges;
                if (find_map(image, instruction.target) < image->map_count)
                    ++out->direct_edges_in_image;
                else
                    ++out->direct_edges_outside_image;
            }
            if (instruction.flags & PL_X86_INSTRUCTION_INDIRECT)
                ++out->indirect_edges;
            if (visit) {
                status = visit(&instruction, context);
                if (status) return status;
            }
        }
    }
    return 0;
}
int pl_x86_catalog_image(const pl_x86_image *image,pl_x86_visit visit,
    void *context,pl_x86_catalog *out)
{ return catalog(image,visit,context,out,0); }
int pl_x86_catalog_profile(const pl_x86_image *image,pl_x86_visit visit,
    void *context,pl_x86_catalog *out)
{ return catalog(image,visit,context,out,1); }

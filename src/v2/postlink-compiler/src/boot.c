#include <postlink/boot.h>
#include <postlink/machine.h>

static pl_u32 text_bytes(const char *text)
{
    pl_u32 bytes = 0u;
    while (text[bytes]) ++bytes;
    return bytes;
}

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    pl_u32 different = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index)
        different |= (pl_u32)(left[index] ^ right[index]);
    return different == 0u;
}

static int value_end(const pl_u8 *header, pl_u32 bytes, pl_u32 cursor)
{
    return cursor == bytes || header[cursor] == ',' || header[cursor] == '}'
        ? 1 : 0;
}

static int read_u64(const pl_u8 *header, pl_u32 bytes, pl_u32 *cursor,
                    pl_u64 *value)
{
    if (!header || !cursor || !value || *cursor >= bytes)
        return PL_ERROR_BOOT_STATE;
    pl_u64 result = 0u;
    pl_u32 digits = 0u;
    while (*cursor < bytes
            && header[*cursor] >= '0' && header[*cursor] <= '9') {
        pl_u64 digit = (pl_u64)(header[*cursor] - '0');
        if (result > (~(pl_u64)0 - digit) / 10u)
            return PL_ERROR_BOOT_STATE;
        result = result * 10u + digit;
        ++*cursor;
        ++digits;
    }
    if (!digits) return PL_ERROR_BOOT_STATE;
    *value = result;
    return 0;
}

static int locate(const pl_u8 *header, pl_u32 bytes, const char *path,
                  pl_u32 *cursor)
{
    return pl_machine_header_locate(header, bytes, path, cursor)
         ? PL_ERROR_BOOT_STATE : 0;
}

static int scalar(const pl_u8 *header, pl_u32 bytes, const char *path,
                  pl_u64 *value)
{
    return pl_machine_header_u64(header, bytes, path, value)
         ? PL_ERROR_BOOT_STATE : 0;
}

static int array(const pl_u8 *header, pl_u32 bytes, const char *path,
                 pl_u64 *values, pl_u32 count)
{
    pl_u32 cursor = 0u;
    if (!values || locate(header, bytes, path, &cursor)
            || cursor >= bytes || header[cursor++] != '[')
        return PL_ERROR_BOOT_STATE;
    for (pl_u32 index = 0u; index < count; ++index) {
        if (read_u64(header, bytes, &cursor, &values[index]))
            return PL_ERROR_BOOT_STATE;
        pl_u8 expected = index + 1u == count ? ']' : ',';
        if (cursor >= bytes || header[cursor++] != expected)
            return PL_ERROR_BOOT_STATE;
    }
    return value_end(header, bytes, cursor)
         ? 0 : PL_ERROR_BOOT_STATE;
}

static int pair_array(const pl_u8 *header, pl_u32 bytes, const char *path,
                      pl_u64 *keys, pl_u64 *values, pl_u32 capacity,
                      pl_u32 *count)
{
    pl_u32 cursor = 0u;
    if (!keys || !values || !count || locate(header, bytes, path, &cursor)
            || cursor >= bytes || header[cursor++] != '[')
        return PL_ERROR_BOOT_STATE;
    pl_u32 used = 0u;
    if (cursor < bytes && header[cursor] == ']') {
        ++cursor;
    } else {
        for (;;) {
            if (used == capacity || cursor >= bytes || header[cursor++] != '['
                    || read_u64(header, bytes, &cursor, &keys[used])
                    || cursor >= bytes || header[cursor++] != ','
                    || read_u64(header, bytes, &cursor, &values[used])
                    || cursor >= bytes || header[cursor++] != ']')
                return PL_ERROR_BOOT_STATE;
            ++used;
            if (cursor >= bytes) return PL_ERROR_BOOT_STATE;
            if (header[cursor] == ']') {
                ++cursor;
                break;
            }
            if (header[cursor++] != ',') return PL_ERROR_BOOT_STATE;
        }
    }
    if (!value_end(header, bytes, cursor)) return PL_ERROR_BOOT_STATE;
    *count = used;
    return 0;
}

static int literal(const pl_u8 *header, pl_u32 bytes, const char *path,
                   const char *expected)
{
    pl_u32 cursor = 0u;
    pl_u32 expected_bytes = text_bytes(expected);
    if (locate(header, bytes, path, &cursor)
            || expected_bytes > bytes - cursor
            || !same_bytes(header + cursor, (const pl_u8 *)expected,
                           expected_bytes)
            || !value_end(header, bytes, cursor + expected_bytes))
        return PL_ERROR_BOOT_STATE;
    return 0;
}

static int state_open(const pl_u8 *bytes, pl_u64 length,
                      pl_executable_state *out, pl_u64 *memory_length)
{
    pl_u32 magic_bytes = text_bytes(PL_X86_STATE_MAGIC);
    if (!bytes || !out || !memory_length || length < magic_bytes + 4u
            || !same_bytes(bytes, (const pl_u8 *)PL_X86_STATE_MAGIC,
                           magic_bytes))
        return PL_ERROR_BOOT_STATE;
    pl_u32 header_bytes = pl_read_u32(bytes + magic_bytes);
    pl_u64 header_offset = (pl_u64)magic_bytes + 4u;
    if (header_bytes != length - header_offset)
        return PL_ERROR_BOOT_STATE;
    const pl_u8 *header = bytes + header_offset;
    if (!header_bytes || header[0] != '{'
            || header[header_bytes - 1u] != '}')
        return PL_ERROR_BOOT_STATE;

    pl_executable_state state = { 0 };
    pl_u64 gdtr[2], idtr[2], segments[6], debug[8];
    pl_u64 base_bytes = 0u, page_bytes = 0u, pages = 0u;
    int status = array(
        header, header_bytes, "registers", state.registers,
        PL_VM_X86_REGISTER_COUNT);
    if (!status)
        status = array(header, header_bytes, "xmm", state.xmm,
                       PL_VM_X86_XMM_WORDS);
    if (!status) status = array(header, header_bytes, "gdtr", gdtr, 2u);
    if (!status) status = array(header, header_bytes, "idtr", idtr, 2u);
    if (!status)
        status = array(header, header_bytes, "segments", segments, 6u);
    if (!status) status = array(header, header_bytes, "debug", debug, 8u);
    if (!status) status = scalar(header, header_bytes, "rip", &state.rip);
    if (!status)
        status = scalar(header, header_bytes, "rflags", &state.rflags);
    if (!status) status = scalar(header, header_bytes, "cr0", &state.cr0);
    if (!status)
        status = scalar(header, header_bytes, "cr3", &state.cr3);
    if (!status) status = scalar(header, header_bytes, "cr4", &state.cr4);
    if (!status) status = scalar(header, header_bytes, "efer", &state.efer);
    if (!status)
        status = scalar(
            header, header_bytes, "memory_length", memory_length);
    if (!status)
        status = scalar(header, header_bytes, "base_bytes", &base_bytes);
    if (!status)
        status = scalar(header, header_bytes, "page_bytes", &page_bytes);
    if (!status) status = scalar(header, header_bytes, "pages", &pages);
    pl_u64 cr2 = 0u, cr8 = 0u, ldtr = 0u, tr = 0u;
    if (!status) status = scalar(header, header_bytes, "cr2", &cr2);
    if (!status) status = scalar(header, header_bytes, "cr8", &cr8);
    if (!status) status = scalar(header, header_bytes, "ldtr", &ldtr);
    if (!status) status = scalar(header, header_bytes, "tr", &tr);
    if (!status)
        status = pair_array(
            header, header_bytes, "msrs", state.msr_keys,
            state.msr_values, PL_VM_X86_MSR_WORDS, &state.msr_count);
    if (!status) status = literal(header, header_bytes, "baseline", "false");
    if (!status) status = literal(header, header_bytes, "halted", "false");
    if (!status)
        status = literal(header, header_bytes, "interrupts", "[]");
    if (!status)
        status = literal(
            header, header_bytes, "page_encoding",
            "\"canonical-region-v1\"");
    if (status || base_bytes || pages || page_bytes != 256u
            || !*memory_length || (*memory_length & 4095u)
            || ldtr > 0xffffu || tr > 0xffffu)
        return PL_ERROR_BOOT_STATE;

    state.system[0] = cr2;
    state.system[1] = cr8;
    state.system[2] = gdtr[0];
    state.system[3] = gdtr[1];
    state.system[4] = idtr[0];
    state.system[5] = idtr[1];
    state.system[6] = segments[2]; /* ES */
    state.system[7] = segments[0]; /* CS */
    state.system[8] = segments[3]; /* SS */
    state.system[9] = segments[1]; /* DS */
    state.system[10] = segments[4]; /* FS */
    state.system[11] = segments[5]; /* GS */
    state.system[12] = ldtr;
    state.system[13] = tr;
    for (pl_u32 index = 0u; index < 8u; ++index)
        state.system[14u + index] = debug[index];
    state.mxcsr = 0x1f80u;
    state.x87_control = 0x037fu;
    state.x87_tag = 0xffffu;
    pl_u8 encoded[PL_EXECUTABLE_STATE_BYTES];
    if (pl_executable_state_write(&state, encoded))
        return PL_ERROR_BOOT_STATE;
    *out = state;
    return 0;
}

int pl_boot_cache_open(const pl_u8 *bytes, pl_u64 length,
                       pl_boot_cache *out)
{
    pl_u32 magic_bytes = text_bytes(PL_BOOT_CACHE_MAGIC);
    if (!bytes || !out || length < magic_bytes + 4u
            || !same_bytes(bytes, (const pl_u8 *)PL_BOOT_CACHE_MAGIC,
                           magic_bytes))
        return PL_ERROR_BOOT;
    pl_u32 header_bytes = pl_read_u32(bytes + magic_bytes);
    pl_u64 header_offset = (pl_u64)magic_bytes + 4u;
    if (!header_bytes || header_bytes > length - header_offset)
        return PL_ERROR_BOOT_RANGE;
    const pl_u8 *header = bytes + header_offset;
    pl_u64 cpu_bytes = 0u, memory_bytes = 0u;
    if (scalar(header, header_bytes, "cpu_bytes", &cpu_bytes)
            || scalar(header, header_bytes, "memory_bytes", &memory_bytes)
            || !cpu_bytes || !memory_bytes)
        return PL_ERROR_BOOT;
    pl_u64 cpu_offset = header_offset + header_bytes;
    if (cpu_bytes > length - cpu_offset)
        return PL_ERROR_BOOT_RANGE;
    pl_u64 memory_offset = cpu_offset + cpu_bytes;
    if (memory_bytes != length - memory_offset)
        return PL_ERROR_BOOT_RANGE;

    pl_boot_cache parsed = { 0 };
    pl_u64 state_memory = 0u;
    int status = state_open(
        bytes + cpu_offset, cpu_bytes, &parsed.state, &state_memory);
    if (!status)
        status = pl_physical_bundle_open(
            bytes + memory_offset, memory_bytes, &parsed.memory);
    if (status || parsed.memory.length != state_memory)
        return status ? status : PL_ERROR_BOOT_STATE;
    parsed.cpu_offset = cpu_offset;
    parsed.cpu_bytes = cpu_bytes;
    parsed.memory_offset = memory_offset;
    parsed.memory_bytes = memory_bytes;
    *out = parsed;
    return 0;
}

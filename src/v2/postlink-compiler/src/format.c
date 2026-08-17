/* Record validation over the canonical layout in <postlink/format.h>.
 *
 * Freestanding: no libc.  The same object links into the native driver and
 * into a wasm32 runtime.
 */

#include <postlink/format.h>

int pl_block_parse(const pl_u8 *record, pl_u32 bytes, pl_block_header *out)
{
    if (bytes < PL_BLOCK_HEADER_BYTES) return PL_ERROR_SHORT;
    if (record[0] != 'X' || record[1] != '8'
            || record[2] != '6' || record[3] != 'B')
        return PL_ERROR_MAGIC;

    pl_u32 version = pl_read_u16(record + PL_BLOCK_OFF_VERSION);
    if (version != PL_BLOCK_VERSION_STEP
            && version != PL_BLOCK_VERSION_PROOF
            && version != PL_BLOCK_VERSION_TEMPLATE)
        return PL_ERROR_VERSION;
    if (pl_read_u16(record + PL_BLOCK_OFF_HEADER_BYTES)
            != PL_BLOCK_HEADER_BYTES)
        return PL_ERROR_HEADER;

    pl_u32 payload = bytes - PL_BLOCK_HEADER_BYTES;
    pl_u32 step_bytes = pl_read_u32(record + PL_BLOCK_OFF_STEP_BYTES);
    pl_u32 control = pl_read_u32(record + PL_BLOCK_OFF_CONTROL);
    pl_u32 parameter_bytes = 0;
    pl_u32 template_bytes = step_bytes;
    if (version == PL_BLOCK_VERSION_TEMPLATE) {
        parameter_bytes = pl_read_u32(record + PL_BLOCK_OFF_PARAMETER_BYTES);
        template_bytes = pl_read_u32(record + PL_BLOCK_OFF_TEMPLATE_BYTES);
    }

    /* Each extent is checked against the remaining payload before it is
     * subtracted, so no intermediate can wrap. */
    if (!step_bytes || !template_bytes || template_bytes > payload)
        return PL_ERROR_EXTENT;
    if (parameter_bytes > payload - template_bytes) return PL_ERROR_EXTENT;
    if (control > (pl_u32)PL_CONTROL_MAX) return PL_ERROR_CONTROL;

    pl_u32 guard_bytes = payload - template_bytes - parameter_bytes;
    if (version == PL_BLOCK_VERSION_STEP && (guard_bytes || parameter_bytes))
        return PL_ERROR_EXTENT;
    if (version == PL_BLOCK_VERSION_PROOF
            && guard_bytes < PL_GUARD_COUNT_BYTES)
        return PL_ERROR_EXTENT;

    /* A version-3 record may carry no proof at all; when it does, the extent
     * must be consumed exactly by the declared entries. */
    if (version == PL_BLOCK_VERSION_PROOF || guard_bytes) {
        const pl_u8 *guard = record + PL_BLOCK_HEADER_BYTES;
        pl_u32 count = pl_read_u16(guard);
        pl_u32 cursor = PL_GUARD_COUNT_BYTES;
        if (!count) return PL_ERROR_GUARD;
        for (pl_u32 index = 0; index < count; ++index) {
            if (cursor > guard_bytes
                    || guard_bytes - cursor < PL_GUARD_ENTRY_BYTES)
                return PL_ERROR_GUARD;
            pl_u32 length = pl_read_u16(guard + cursor + 8u);
            cursor += PL_GUARD_ENTRY_BYTES;
            if (!length || guard_bytes - cursor < length)
                return PL_ERROR_GUARD;
            cursor += length;
        }
        if (cursor != guard_bytes) return PL_ERROR_GUARD;
    }

    if (out) {
        out->version = version;
        out->header_bytes = PL_BLOCK_HEADER_BYTES;
        out->rip = pl_read_u64(record + PL_BLOCK_OFF_RIP);
        out->boundary_rip = pl_read_u64(record + PL_BLOCK_OFF_BOUNDARY_RIP);
        out->step_bytes = step_bytes;
        out->control = control;
        out->argument[0] = pl_read_u64(record + PL_BLOCK_OFF_ARGUMENT_0);
        out->argument[1] = pl_read_u64(record + PL_BLOCK_OFF_ARGUMENT_1);
        out->argument[2] = pl_read_u64(record + PL_BLOCK_OFF_ARGUMENT_2);
        out->parameter_bytes = parameter_bytes;
        out->template_bytes = template_bytes;
        out->guard_bytes = guard_bytes;
    }
    return 0;
}

static const char *const CONTROL_NAMES[] = {
    "next", "branch", "conditional", "dynamic", "halt", "timeslice",
    "write-msr", "read-msr", "cpuid", "register", "segment", "descriptor",
    "far-return", "divide", "interrupt-return", "internal", "read-segment",
    "port-read", "port-write", "invalidate-page", "clock", "debug-register",
    "exception", "wide-divide", "recurrence", "entropy", "store-descriptor",
    "system-segment", "swap-gs", "syscall", "sysret", "simd-move",
    "simd-unpack", "simd-store", "segment-memory", "simd-xor", "simd-load",
    "simd-register", "simd-compare", "simd-convert", "simd-scalar",
    "fpu-save", "fpu-restore",
};

const char *pl_control_name(pl_u32 control)
{
    if (control > (pl_u32)PL_CONTROL_MAX) return "unknown";
    return CONTROL_NAMES[control];
}

const char *pl_error_name(int error)
{
    switch (error) {
    case 0:                return "ok";
    case PL_ERROR_SHORT:   return "record is shorter than its header";
    case PL_ERROR_MAGIC:   return "record does not begin with X86B";
    case PL_ERROR_VERSION: return "record version is not 1, 2 or 3";
    case PL_ERROR_HEADER:  return "declared header extent is not 64 bytes";
    case PL_ERROR_EXTENT:  return "payload extents do not tile the record";
    case PL_ERROR_CONTROL: return "control code is above the known maximum";
    case PL_ERROR_GUARD:   return "executable proof is not well formed";
    default:               return "unknown";
    }
}

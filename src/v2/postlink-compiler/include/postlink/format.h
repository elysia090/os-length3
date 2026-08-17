/* Canonical on-artifact layout of the x86 post-link machine.
 *
 * This header is the single definition of the format.  Until the port is
 * complete the same numbers also appear in kernel/x86snapshot.py (writer) and
 * web/x86-machine.js (reader); check/format_parity.py fails the build when any
 * of the three drift.  Both of those copies are scheduled for removal, so no
 * new constant may be introduced anywhere but here.
 *
 * Freestanding: this header uses no libc and no compiler builtins, so it
 * compiles unchanged for x86-64 (host or guest), wasm32, and any other target
 * gcc supports.
 */

#ifndef POSTLINK_FORMAT_H
#define POSTLINK_FORMAT_H

typedef unsigned char      pl_u8;
typedef unsigned short     pl_u16;
typedef unsigned int       pl_u32;
typedef unsigned long long pl_u64;
typedef signed long long   pl_i64;

/* ---------------------------------------------------------------- artifact */

/* Container magics.  A reader accepts exactly one; older versions are named
 * so a mismatch can be reported precisely instead of as a generic parse
 * failure. */
#define PL_MACHINE_MAGIC_V1 "x86-native-machine-v1\n"
#define PL_MACHINE_MAGIC_V2 "x86-native-machine-v2\n"
#define PL_MACHINE_MAGIC_V3 "x86-native-machine-v3\n"
#define PL_MACHINE_MAGIC_V4 "x86-native-machine-v4\n"
#define PL_MACHINE_MAGIC_V5 "x86-native-machine-v5\n"
#define PL_MACHINE_MAGIC    PL_MACHINE_MAGIC_V5

#define PL_BOOT_CACHE_MAGIC "x86-boot-cache-v1\n"

/* Region alignment of the three independently mapped extents: physical-memory
 * backing, block/residual descriptors, executable projections. */
#define PL_REGION_BYTES        (1u << 16)
#define PL_PHYSICAL_PAGE_BYTES 4096u

/* ------------------------------------------------------------ block record */

/* One admitted block.  'X86B' is the record a runtime validates and executes;
 * 'X86D' is the descriptor row the artifact stores instead, from which the
 * runtime reconstructs the X86B on a block-cache miss. */
#define PL_BLOCK_MAGIC      "X86B"
#define PL_DESCRIPTOR_MAGIC "X86D"

#define PL_BLOCK_HEADER_BYTES 64u

/* Record versions.  1 = STEP only; 2 = exact executable proof + STEP;
 * 3 = proof + typed parameter projection + shared SSA template. */
#define PL_BLOCK_VERSION_STEP      1u
#define PL_BLOCK_VERSION_PROOF     2u
#define PL_BLOCK_VERSION_TEMPLATE  3u

/* Byte offsets inside the 64-byte header.  PARAMETER_BYTES and TEMPLATE_BYTES
 * occupy the trailing eight bytes and are reserved (zero) below version 3. */
#define PL_BLOCK_OFF_MAGIC            0u
#define PL_BLOCK_OFF_VERSION          4u   /* u16 */
#define PL_BLOCK_OFF_HEADER_BYTES     6u   /* u16, == PL_BLOCK_HEADER_BYTES */
#define PL_BLOCK_OFF_RIP              8u   /* u64 */
#define PL_BLOCK_OFF_BOUNDARY_RIP    16u   /* u64 */
#define PL_BLOCK_OFF_STEP_BYTES      24u   /* u32 */
#define PL_BLOCK_OFF_CONTROL         28u   /* u32 */
#define PL_BLOCK_OFF_ARGUMENT_0      32u   /* u64 */
#define PL_BLOCK_OFF_ARGUMENT_1      40u   /* u64 */
#define PL_BLOCK_OFF_ARGUMENT_2      48u   /* u64 */
#define PL_BLOCK_OFF_PARAMETER_BYTES 56u   /* u32, version 3 */
#define PL_BLOCK_OFF_TEMPLATE_BYTES  60u   /* u32, version 3 */

/* Payload order after the header: guard, then parameters, then template.
 * Guard bytes are the exact executable proof, laid out as
 *
 *     u16 count
 *     count * { u64 address; u16 length; u8 bytes[length]; }
 *
 * and must consume the guard extent exactly. */
#define PL_GUARD_COUNT_BYTES  2u
#define PL_GUARD_ENTRY_BYTES 10u   /* u64 address + u16 length */

/* ---------------------------------------------------------------- control */

/* Terminal projection of a block.  A record whose control exceeds
 * PL_CONTROL_MAX is rejected; the values are artifact-visible and therefore
 * append-only. */
enum pl_control {
    PL_CONTROL_NEXT              = 0,
    PL_CONTROL_BRANCH            = 1,
    PL_CONTROL_CONDITIONAL       = 2,
    PL_CONTROL_DYNAMIC           = 3,
    PL_CONTROL_HALT              = 4,
    PL_CONTROL_TIMESLICE         = 5,
    PL_CONTROL_WRITE_MSR         = 6,
    PL_CONTROL_READ_MSR          = 7,
    PL_CONTROL_CPUID             = 8,
    PL_CONTROL_REGISTER          = 9,
    PL_CONTROL_SEGMENT           = 10,
    PL_CONTROL_DESCRIPTOR        = 11,
    PL_CONTROL_FAR_RETURN        = 12,
    PL_CONTROL_DIVIDE            = 13,
    PL_CONTROL_INTERRUPT_RETURN  = 14,
    PL_CONTROL_INTERNAL          = 15,
    PL_CONTROL_READ_SEGMENT      = 16,
    PL_CONTROL_PORT_READ         = 17,
    PL_CONTROL_PORT_WRITE        = 18,
    PL_CONTROL_INVALIDATE_PAGE   = 19,
    PL_CONTROL_CLOCK             = 20,
    PL_CONTROL_DEBUG_REGISTER    = 21,
    PL_CONTROL_EXCEPTION         = 22,
    PL_CONTROL_WIDE_DIVIDE       = 23,
    PL_CONTROL_RECURRENCE        = 24,
    PL_CONTROL_ENTROPY           = 25,
    PL_CONTROL_STORE_DESCRIPTOR  = 26,
    PL_CONTROL_SYSTEM_SEGMENT    = 27,
    PL_CONTROL_SWAP_GS           = 28,
    PL_CONTROL_SYSCALL           = 29,
    PL_CONTROL_SYSRET            = 30,
    PL_CONTROL_SIMD_MOVE         = 31,
    PL_CONTROL_SIMD_UNPACK       = 32,
    PL_CONTROL_SIMD_STORE        = 33,
    PL_CONTROL_SEGMENT_MEMORY    = 34,
    PL_CONTROL_SIMD_XOR          = 35,
    PL_CONTROL_SIMD_LOAD         = 36,
    PL_CONTROL_SIMD_REGISTER     = 37,
    PL_CONTROL_SIMD_COMPARE      = 38,
    PL_CONTROL_SIMD_CONVERT      = 39,
    PL_CONTROL_SIMD_SCALAR       = 40,
    PL_CONTROL_FPU_SAVE          = 41,
    PL_CONTROL_FPU_RESTORE       = 42
};

#define PL_CONTROL_MAX PL_CONTROL_FPU_RESTORE

/* Controls whose first continuation field is a static target and therefore
 * stored as a displacement from RIP.  CONDITIONAL additionally stores its
 * second field relative when that field is non-zero. */
#define PL_CONTROL_IS_STATIC(control) \
    ((control) == PL_CONTROL_BRANCH || (control) == PL_CONTROL_CONDITIONAL)

/* Controls that keep an exact first field rather than a displacement. */
#define PL_CONTROL_FIELD_IS_EXACT(control)                              \
    ((control) == PL_CONTROL_NEXT || (control) == PL_CONTROL_DYNAMIC    \
     || (control) == PL_CONTROL_HALT || (control) == PL_CONTROL_TIMESLICE \
     || (control) == PL_CONTROL_FAR_RETURN                              \
     || (control) == PL_CONTROL_INTERRUPT_RETURN                        \
     || (control) == PL_CONTROL_EXCEPTION)

/* ----------------------------------------------------------- continuation */

/* A continuation row is
 *
 *     u8  control
 *     u16 tags        four three-bit codes, low field first
 *     ...             the selected residuals, in field order
 *
 * so a common branch costs three bytes plus one small displacement.  The tag
 * codes are shared by all four fields; codes 1 and 2 are only legal once an
 * earlier field exists to name. */
#define PL_CONTINUATION_FIELDS 4u
#define PL_CONTINUATION_TAG_BITS 3u
#define PL_CONTINUATION_HEADER_BYTES 3u

#define PL_TAG_ZERO      0u  /* the field is zero */
#define PL_TAG_FIELD_0   1u  /* equal to field 0 */
#define PL_TAG_FIELD_1   2u  /* equal to field 1 */
#define PL_TAG_SIGNED_8  3u  /* signed 1-byte residual */
#define PL_TAG_SIGNED_16 4u  /* signed 2-byte residual */
#define PL_TAG_SIGNED_32 5u  /* signed 4-byte residual */
#define PL_TAG_SIGNED_64 6u  /* signed 8-byte residual */
#define PL_TAG_NEXT      7u  /* the successor is the following block row */
#define PL_TAG_MAX       PL_TAG_NEXT

/* Schema 6 adds one field to the continuation: the rank of the primary static
 * successor, stored as a delta from the block's own row.  A dispatch is a RIP
 * lookup, and 94.1% of blocks in the shipped artifact have a successor that was
 * fixed at compile time, so for those the lookup is a constant and belongs in
 * the block.
 *
 * The field costs nothing in the common case.  41.4% of static edges target the
 * immediately following row, which PL_TAG_NEXT spells with no payload at all;
 * of the rest, measured over 279,371 edges, 240,253 fit one signed byte, 23,913
 * two, 14,397 four, and none need eight.  Five three-bit tags still fit the
 * same u16, so the row shape does not change.
 *
 * PL_TAG_ZERO in this field means the dispatch is not foldable -- the successor
 * is a runtime value, or the coordinate carries several proof variants and the
 * runtime must select among them. */
#define PL_CONTINUATION_FIELDS_CHAINED 5u
#define PL_FIELD_CHAIN 4u

/* Residual width in bytes for a signed tag, 0 for the non-scalar tags. */
#define PL_TAG_WIDTH(tag)                                       \
    ((tag) == PL_TAG_SIGNED_8  ? 1u :                           \
     (tag) == PL_TAG_SIGNED_16 ? 2u :                           \
     (tag) == PL_TAG_SIGNED_32 ? 4u :                           \
     (tag) == PL_TAG_SIGNED_64 ? 8u : 0u)

/* ------------------------------------------------------- scalar accessors */

/* Little-endian regardless of host, so an artifact built on one machine loads
 * on another without a byte-order field. */

static inline pl_u32 pl_read_u16(const pl_u8 *source)
{
    return (pl_u32)source[0] | ((pl_u32)source[1] << 8);
}

static inline pl_u32 pl_read_u32(const pl_u8 *source)
{
    return (pl_u32)source[0] | ((pl_u32)source[1] << 8)
         | ((pl_u32)source[2] << 16) | ((pl_u32)source[3] << 24);
}

static inline pl_u64 pl_read_u64(const pl_u8 *source)
{
    return (pl_u64)pl_read_u32(source)
         | ((pl_u64)pl_read_u32(source + 4) << 32);
}

static inline void pl_write_u16(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8);
}

static inline void pl_write_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8);
    target[2] = (pl_u8)(value >> 16);
    target[3] = (pl_u8)(value >> 24);
}

static inline void pl_write_u64(pl_u8 *target, pl_u64 value)
{
    pl_write_u32(target, (pl_u32)value);
    pl_write_u32(target + 4, (pl_u32)(value >> 32));
}

/* Sign-extend a residual of `width` bytes read little-endian from `source`. */
static inline pl_i64 pl_read_signed(const pl_u8 *source, pl_u32 width)
{
    pl_u64 value = 0;
    for (pl_u32 index = 0; index < width; ++index)
        value |= (pl_u64)source[index] << (index * 8u);
    if (width < 8u && (value >> (width * 8u - 1u)) & 1u)
        value |= ~(pl_u64)0 << (width * 8u);
    return (pl_i64)value;
}

/* The narrowest signed tag that represents `value` exactly. */
static inline pl_u32 pl_signed_tag(pl_i64 value)
{
    if (value >= -128 && value < 128) return PL_TAG_SIGNED_8;
    if (value >= -32768 && value < 32768) return PL_TAG_SIGNED_16;
    if (value >= -2147483648LL && value < 2147483648LL)
        return PL_TAG_SIGNED_32;
    return PL_TAG_SIGNED_64;
}

/* ------------------------------------------------------------ block header */

typedef struct {
    pl_u32 version;
    pl_u32 header_bytes;
    pl_u64 rip;
    pl_u64 boundary_rip;
    pl_u32 step_bytes;
    pl_u32 control;
    pl_u64 argument[3];
    pl_u32 parameter_bytes;
    pl_u32 template_bytes;
    pl_u32 guard_bytes;
} pl_block_header;

/* Parse and validate a whole record.  Returns 0 on success, or a negative
 * PL_ERROR_* code.  `bytes` is the complete record extent; on success the
 * payload extents satisfy
 *
 *     guard_bytes + parameter_bytes + template_bytes
 *         == bytes - PL_BLOCK_HEADER_BYTES
 *
 * and the guard extent has been shown to be internally well formed.  Proof
 * bytes are not compared against memory here: that needs a machine. */
#define PL_ERROR_SHORT      (-1)
#define PL_ERROR_MAGIC      (-2)
#define PL_ERROR_VERSION    (-3)
#define PL_ERROR_HEADER     (-4)
#define PL_ERROR_EXTENT     (-5)
#define PL_ERROR_CONTROL    (-6)
#define PL_ERROR_GUARD      (-7)

int pl_block_parse(const pl_u8 *record, pl_u32 bytes, pl_block_header *out);

/* Human-readable name for a control code, or "unknown". */
const char *pl_control_name(pl_u32 control);

/* Human-readable name for a PL_ERROR_* code. */
const char *pl_error_name(int error);

#endif /* POSTLINK_FORMAT_H */

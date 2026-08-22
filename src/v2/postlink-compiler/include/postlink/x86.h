/* Linked-x86 input and source-instruction cuts.
 *
 * This is deliberately not a decoder-library-shaped interface.  A decoder is
 * cold compiler machinery; the stable object is the exact source coordinate,
 * normalized operands and architectural cut it proves.  No value declared in
 * this header is a runtime STEP opcode or a third-party enum.
 */

#ifndef POSTLINK_X86_H
#define POSTLINK_X86_H

#include <postlink/elf.h>

#define PL_X86_MAX_INSTRUCTION_BYTES 15u
#define PL_X86_MAX_OPERANDS          10u

#define PL_ERROR_X86          (-40)
#define PL_ERROR_X86_MAP      (-41)
#define PL_ERROR_X86_CAPACITY (-42)

enum pl_x86_decode_status {
    PL_X86_DECODE_VALID = 0,
    PL_X86_DECODE_INVALID,
    PL_X86_DECODE_TOO_LONG,
    PL_X86_DECODE_FETCH_FAULT,
};

enum pl_x86_flow {
    PL_X86_FLOW_NEXT = 0,
    PL_X86_FLOW_CONDITIONAL,
    PL_X86_FLOW_JUMP,
    PL_X86_FLOW_CALL,
    PL_X86_FLOW_RETURN,
    PL_X86_FLOW_INTERRUPT,
    PL_X86_FLOW_SYSTEM,
    PL_X86_FLOW_HALT,
    PL_X86_FLOW_FAULT,
};

enum pl_x86_family {
    PL_X86_FAMILY_GENERAL = 0,
    PL_X86_FAMILY_DIVIDE_UNSIGNED,
    PL_X86_FAMILY_DIVIDE_SIGNED,
    PL_X86_FAMILY_BRANCH,
    PL_X86_FAMILY_CALL,
    PL_X86_FAMILY_RETURN,
    PL_X86_FAMILY_INTERRUPT,
    PL_X86_FAMILY_SYSTEM,
    PL_X86_FAMILY_HALT,
    PL_X86_FAMILY_INVALID,
};

/* Typed operations at the CPU/MMU boundary.  These are architectural
 * transfers implemented by vm.wasm, not host events and not interpreter
 * opcodes.  Zero is deliberately an anonymous barrier and cannot publish. */
enum pl_x86_machine_operation {
    PL_X86_MACHINE_NONE = 0,
    PL_X86_MACHINE_WRITE_MSR,
    PL_X86_MACHINE_FAR_RETURN,
    PL_X86_MACHINE_WRITE_CONTROL,
    PL_X86_MACHINE_READ_CONTROL,
    PL_X86_MACHINE_WRITE_SEGMENT,
    PL_X86_MACHINE_DESCRIPTOR_TABLE,
    PL_X86_MACHINE_POP_FLAGS,
    PL_X86_MACHINE_READ_MSR,
    PL_X86_MACHINE_CPUID,
    PL_X86_MACHINE_INTERRUPT_FLAG,
    PL_X86_MACHINE_PORT_IO,
    PL_X86_MACHINE_SWAP_GS,
    PL_X86_MACHINE_HALT,
    PL_X86_MACHINE_INVALIDATE_PAGE,
    PL_X86_MACHINE_SYSTEM_TRANSFER,
    PL_X86_MACHINE_INTERRUPT_RETURN,
    PL_X86_MACHINE_ATOMIC,
    PL_X86_MACHINE_VECTOR,
    PL_X86_MACHINE_READ_SELECTOR,
    PL_X86_MACHINE_SOFTWARE_INTERRUPT,
    PL_X86_MACHINE_FAR_TRANSFER,
    PL_X86_MACHINE_X87,
    PL_X86_MACHINE_TIME,
    PL_X86_MACHINE_VALIDATE_SELECTOR,
    PL_X86_MACHINE_STRING,
    PL_X86_MACHINE_MEMORY_ORDER,
    PL_X86_MACHINE_DEBUG_REGISTER,
    PL_X86_MACHINE_SYSTEM_SELECTOR,
    PL_X86_MACHINE_CR0_STATUS,
    PL_X86_MACHINE_SEGMENT_STACK,
    PL_X86_MACHINE_ENTROPY,
};

/* Stable semantic operations used by the post-link compiler.  These are not
 * decoder-library mnemonic values: one operation names one architectural
 * transfer shape even when x86 has several encodings for it.  Zero is an
 * explicit compile-time grammar miss and can never be published as an
 * executable function. */
enum pl_x86_operation {
    PL_X86_OPERATION_UNSUPPORTED = 0,
    PL_X86_OPERATION_FAULT,
    PL_X86_OPERATION_NOP,
    PL_X86_OPERATION_MOVE,
    PL_X86_OPERATION_MOVE_ZERO_EXTEND,
    PL_X86_OPERATION_MOVE_SIGN_EXTEND,
    PL_X86_OPERATION_LOAD_ADDRESS,
    PL_X86_OPERATION_EXCHANGE,
    PL_X86_OPERATION_ADD,
    PL_X86_OPERATION_ADD_CARRY,
    PL_X86_OPERATION_SUBTRACT,
    PL_X86_OPERATION_SUBTRACT_BORROW,
    PL_X86_OPERATION_AND,
    PL_X86_OPERATION_OR,
    PL_X86_OPERATION_XOR,
    PL_X86_OPERATION_COMPARE,
    PL_X86_OPERATION_TEST,
    PL_X86_OPERATION_INCREMENT,
    PL_X86_OPERATION_DECREMENT,
    PL_X86_OPERATION_NEGATE,
    PL_X86_OPERATION_COMPLEMENT,
    PL_X86_OPERATION_BRANCH,
    PL_X86_OPERATION_CALL,
    PL_X86_OPERATION_RETURN,
    PL_X86_OPERATION_PUSH,
    PL_X86_OPERATION_POP,
    PL_X86_OPERATION_SHIFT,
    PL_X86_OPERATION_FLAG_CONTROL,
    PL_X86_OPERATION_LEAVE,
    PL_X86_OPERATION_ACCUMULATOR_EXTEND,
    PL_X86_OPERATION_HIGH_EXTEND,
    PL_X86_OPERATION_CONDITIONAL_SET,
    PL_X86_OPERATION_CONDITIONAL_MOVE,
    PL_X86_OPERATION_MULTIPLY_UNSIGNED,
    PL_X86_OPERATION_MULTIPLY_SIGNED,
    PL_X86_OPERATION_DIVIDE_UNSIGNED,
    PL_X86_OPERATION_DIVIDE_SIGNED,
    PL_X86_OPERATION_LOOP,
    PL_X86_OPERATION_COUNT_ZERO_BRANCH,
    PL_X86_OPERATION_PUSH_FLAGS,
    PL_X86_OPERATION_POP_FLAGS,
    PL_X86_OPERATION_LOAD_FLAGS_LOW,
    PL_X86_OPERATION_STORE_FLAGS_LOW,
    PL_X86_OPERATION_BIT_TEST,
    PL_X86_OPERATION_TRANSLATE_BYTE,
    PL_X86_OPERATION_BYTE_SWAP,
    PL_X86_OPERATION_ENTER,
    PL_X86_OPERATION_STRING,
    PL_X86_OPERATION_EXCHANGE_ADD,
    PL_X86_OPERATION_COMPARE_EXCHANGE,
    PL_X86_OPERATION_SHIFT_NO_FLAGS,
    PL_X86_OPERATION_BIT_SUMMARY,
    PL_X86_OPERATION_DOUBLE_SHIFT,
    PL_X86_OPERATION_AND_NOT,
    PL_X86_OPERATION_MOVE_BYTE_SWAP,
    PL_X86_OPERATION_BASE_ACCESS,
    PL_X86_OPERATION_CRC32,
    PL_X86_OPERATION_BZHI,
    PL_X86_OPERATION_MAX = PL_X86_OPERATION_BZHI,
};

enum pl_x86_encoding {
    PL_X86_ENCODING_LEGACY = 0,
    PL_X86_ENCODING_3DNOW,
    PL_X86_ENCODING_XOP,
    PL_X86_ENCODING_VEX,
    PL_X86_ENCODING_EVEX,
    PL_X86_ENCODING_MVEX,
};

enum pl_x86_elf_coordinates {
    PL_X86_ELF_VIRTUAL = 0,
    PL_X86_ELF_PHYSICAL = 1,
};

enum pl_x86_register_class {
    PL_X86_REGISTER_NONE = 0,
    PL_X86_REGISTER_GPR,
    PL_X86_REGISTER_X87,
    PL_X86_REGISTER_MMX,
    PL_X86_REGISTER_VECTOR,
    PL_X86_REGISTER_TILE,
    PL_X86_REGISTER_FLAGS,
    PL_X86_REGISTER_IP,
    PL_X86_REGISTER_SEGMENT,
    PL_X86_REGISTER_TABLE,
    PL_X86_REGISTER_TEST,
    PL_X86_REGISTER_CONTROL,
    PL_X86_REGISTER_DEBUG,
    PL_X86_REGISTER_MASK,
    PL_X86_REGISTER_BOUND,
};

#define PL_X86_REGISTER_HIGH8 1u

typedef struct {
    pl_u8 class_id;
    pl_u8 index;
    pl_u16 bits;
    pl_u32 flags;
} pl_x86_register;

enum pl_x86_operand_kind {
    PL_X86_OPERAND_NONE = 0,
    PL_X86_OPERAND_REGISTER,
    PL_X86_OPERAND_MEMORY,
    PL_X86_OPERAND_IMMEDIATE,
    PL_X86_OPERAND_POINTER,
};

#define PL_X86_OPERAND_READ              (1u << 0u)
#define PL_X86_OPERAND_WRITE             (1u << 1u)
#define PL_X86_OPERAND_CONDITIONAL_READ  (1u << 2u)
#define PL_X86_OPERAND_CONDITIONAL_WRITE (1u << 3u)
#define PL_X86_OPERAND_EXPLICIT          (1u << 4u)
#define PL_X86_OPERAND_ADDRESS_ONLY      (1u << 5u)
#define PL_X86_OPERAND_RELATIVE          (1u << 6u)
#define PL_X86_OPERAND_SIGNED            (1u << 7u)

typedef struct {
    pl_x86_register segment;
    pl_x86_register base;
    pl_x86_register index;
    pl_i64 displacement;
    pl_u8 scale;
    pl_u8 has_displacement;
    pl_u16 reserved;
} pl_x86_memory;

typedef struct {
    pl_u8 kind;
    pl_u8 reserved;
    pl_u16 bits;
    pl_u32 flags;
    union {
        pl_x86_register reg;
        pl_x86_memory memory;
        pl_u64 immediate;
        struct { pl_u16 segment; pl_u16 reserved; pl_u32 offset; } pointer;
    } value;
} pl_x86_operand;

/* Instruction flags are facts used by block formation and publication.  In
 * particular PRECISE_CUT says that a source-instruction boundary may not be
 * erased merely because its SSA happens to compose. */
#define PL_X86_INSTRUCTION_READS_MEMORY  (1u << 0u)
#define PL_X86_INSTRUCTION_WRITES_MEMORY (1u << 1u)
#define PL_X86_INSTRUCTION_MAY_TRAP      (1u << 2u)
#define PL_X86_INSTRUCTION_PRECISE_CUT   (1u << 3u)
#define PL_X86_INSTRUCTION_DIRECT_TARGET (1u << 4u)
#define PL_X86_INSTRUCTION_INDIRECT      (1u << 5u)
#define PL_X86_INSTRUCTION_FALLTHROUGH   (1u << 6u)
#define PL_X86_INSTRUCTION_LOCKED        (1u << 7u)
#define PL_X86_INSTRUCTION_PRIVILEGED    (1u << 8u)
#define PL_X86_INSTRUCTION_BARRIER       (1u << 9u)
#define PL_X86_INSTRUCTION_REPEATED      (1u << 10u)
#define PL_X86_INSTRUCTION_REPEAT_WHILE_NOT_EQUAL (1u << 11u)
#define PL_X86_INSTRUCTION_TRAP_AFTER    (1u << 12u)

typedef struct {
    pl_u64 rip;
    pl_u64 fallthrough;
    pl_u64 target;
    pl_u32 flags;
    pl_u16 operand_width;
    pl_u16 address_width;
    pl_u8 length;
    pl_u8 status;
    pl_u8 flow;
    pl_u8 family;
    pl_u8 encoding;
    pl_u8 opcode_map;
    pl_u8 opcode;
    pl_u8 trap_vector;
    pl_u8 operand_count;
    pl_u8 visible_operand_count;
    pl_u8 source_bytes;
    pl_u8 operation;
    pl_u8 condition;
    pl_u8 machine_operation;
    pl_u64 machine_argument;
    pl_u8 source[PL_X86_MAX_INSTRUCTION_BYTES];
    pl_x86_operand operands[PL_X86_MAX_OPERANDS];
} pl_x86_instruction;

/* A source map points directly into immutable linked bytes.  memory_bytes may
 * exceed file_bytes; the tail is a zero projection and is never materialized.
 * Maps are sorted and non-overlapping after validation. */
typedef struct {
    const pl_u8 *bytes;
    pl_u64 address;
    pl_u64 file_bytes;
    pl_u64 memory_bytes;
    pl_u32 flags;
    pl_u32 generation;
} pl_x86_map;

typedef struct {
    const pl_x86_map *maps;
    pl_u32 map_count;
    pl_u32 reserved;
    pl_u64 entry;
} pl_x86_image;

/* A validated sparse source reader.  Opening proves the map table once;
 * subsequent materializations touch only maps intersecting the requested
 * range and spell unmapped or zero-fill bytes as zero. */
typedef struct {
    const pl_x86_image *image;
} pl_x86_image_reader;

/* An opened frontend proves the caller-owned image once.  Maps and their
 * linked bytes are immutable until the frontend is discarded. */
typedef struct {
    const pl_x86_image *image;
} pl_x86_frontend;

typedef struct {
    pl_u64 coordinates;
    pl_u64 decoded;
    pl_u64 invalid;
    pl_u64 overlong;
    pl_u64 fetch_faults;
    pl_u64 fault_functions;
    pl_u64 precise_cuts;
    pl_u64 direct_edges;
    pl_u64 direct_edges_in_image;
    pl_u64 direct_edges_outside_image;
    pl_u64 indirect_edges;
} pl_x86_catalog;

typedef int (*pl_x86_visit)(const pl_x86_instruction *instruction,
                            void *context);

int pl_x86_image_validate(const pl_x86_image *image);
int pl_x86_image_contains(const pl_x86_image *image, pl_u64 address);

/* Project executable PT_LOAD segments into caller-owned sorted maps. */
int pl_x86_elf_map_count(const pl_elf_image *elf, pl_u32 *count);
int pl_x86_image_from_elf(const pl_elf_image *elf, pl_u64 load_bias,
                          pl_u32 generation, pl_x86_map *maps,
                          pl_u32 capacity, pl_x86_image *out);
int pl_x86_image_from_elf_coordinates(
    const pl_elf_image *elf, pl_u64 load_bias, pl_u32 generation,
    pl_u32 coordinates, pl_x86_map *maps, pl_u32 capacity,
    pl_x86_image *out);

/* Publish both the pre-paging physical and post-paging virtual aliases of one
 * linked image.  Capacity must allow twice pl_x86_elf_map_count; identical
 * aliases are deduplicated before validation. */
int pl_x86_image_from_elf_aliases(
    const pl_elf_image *elf, pl_u64 virtual_bias, pl_u64 physical_bias,
    pl_u32 generation, pl_x86_map *maps, pl_u32 capacity,
    pl_x86_image *out);

/* Read up to capacity contiguous mapped bytes without allocating. */
int pl_x86_image_read(const pl_x86_image *image, pl_u64 address,
                      pl_u8 *bytes, pl_u32 capacity, pl_u32 *read);
int pl_x86_image_reader_open(
    pl_x86_image_reader *reader, const pl_x86_image *image);
int pl_x86_image_materialize(
    const pl_x86_image_reader *reader, pl_u64 address,
    pl_u8 *bytes, pl_u32 count);

/* Decode one coordinate into a total architectural result.  Invalid encodings,
 * overlong instructions and truncated instruction fetches return a FAULT row,
 * not an absent block. */
int pl_x86_decode(const pl_x86_image *image, pl_u64 rip,
                  pl_x86_instruction *out);

int pl_x86_frontend_open(const pl_x86_image *image,
                         pl_x86_frontend *out);
int pl_x86_frontend_contains(const pl_x86_frontend *frontend,
                             pl_u64 address);
int pl_x86_frontend_decode(const pl_x86_frontend *frontend, pl_u64 rip,
                           pl_x86_instruction *out);

/* Conservative transfer identity.  Absolute proof coordinates are excluded;
 * normalized relative immediates and exact source bytes remain for ordinary
 * instructions.  A terminal architectural fault is already canonical by its
 * vector: its bytes belong to the separate code proof and its current RIP is
 * machine state.  This shares physical/virtual aliases and all equal fault
 * functions safely, while later SSA/QM ranking may merge different valid
 * encodings with the same residual behaviour. */
pl_u64 pl_x86_transfer_hash(const pl_x86_instruction *instruction);
int pl_x86_transfer_equal(const pl_x86_instruction *left,
                          const pl_x86_instruction *right);

/* Decode every byte coordinate in every executable map.  This is intentionally
 * stronger than linear disassembly and boot-trace discovery: every indirect
 * target the machine can publish already has a function or a fault row. */
int pl_x86_catalog_image(const pl_x86_image *image, pl_x86_visit visit,
                         void *context, pl_x86_catalog *out);

#endif /* POSTLINK_X86_H */

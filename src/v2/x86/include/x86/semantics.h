/* Exact x86 instruction semantics lowered into the shared physical SSA. */

#ifndef X86_SEMANTICS_H
#define X86_SEMANTICS_H

#include <x86/ssa.h>
#include <x86/profile.h>
#include <x86/decode.h>

#define PL_X86_GPR_COUNT       16u
#define PL_X86_RFLAGS_LOCAL    16u
#define PL_X86_FS_BASE_LOCAL   17u
#define PL_X86_GS_BASE_LOCAL   18u
#define PL_X86_LOCAL_COUNT     19u

#define PL_ERROR_X86_SEMANTIC (-43)

typedef struct {
    pl_plan plan;
    pl_u64 successor[2];
    pl_operand target;
    pl_operand predicate;
    pl_operand fault_predicate;
    pl_operand machine_value;
    pl_u32 successor_count;
    /* Transient scalar dependencies of an opaque architectural transfer. */
    pl_u32 machine_inputs;
    pl_u8 flow;
    pl_u8 dynamic_target;
    pl_u8 has_predicate;
    pl_u8 has_fault_predicate;
    pl_u8 trap_vector;
    pl_u8 machine_operation;
    pl_u64 machine_argument;
} pl_x86_semantic;

/* Lower one already-decoded source instruction.  A grammar miss is a compiler
 * error, never a request for an interpreter.  The initial frame is the sixteen
 * x86-64 GPR coordinates followed by RFLAGS, FS.base and GS.base. */
int pl_x86_lower(const pl_x86_instruction *instruction,
                 pl_arena *arena, pl_x86_semantic *out);

/* The complete decoded operand set, including hidden and conditional reads,
 * is the single source of scalar dependencies at a machine barrier. */
pl_u32 pl_x86_machine_inputs(const pl_x86_instruction *instruction);

/* A privileged halt has no value-state operands. Its continuation is the
 * decoded fallthrough, retained across the machine's interrupt wait. */
int pl_x86_halt_supported(const pl_x86_instruction *instruction);
typedef struct { pl_u8 bits,decrement,zero_flag; } pl_x86_count_branch;
/* RCX/CX/ECX count and optional incoming ZF; no arithmetic flag producer.
 * The shared law covers LOOP/LOOPE/LOOPNE and count-zero branches. */
int pl_x86_count_branch_lower(const pl_x86_instruction *instruction,pl_x86_count_branch *out);
typedef struct { pl_u8 vector,bytes; } pl_x86_fault_cut;
/* A decoder-proved synchronous #UD/#GP with a decisive source extent. Fetch
 * incompleteness and trap-after instructions are different machine futures. */
int pl_x86_fault_cut_lower(const pl_x86_instruction *instruction,pl_x86_fault_cut *out);

typedef struct { pl_u8 bits,compare; } pl_x86_register_update;
/* Simultaneous old-value capture, add/exchange or accumulator comparison.
 * Narrow conditional writes preserve every unselected parent bit. */
int pl_x86_register_update_lower(const pl_x86_instruction *instruction,pl_x86_register_update *out);

typedef struct {
    pl_u8 kind,bits,address_bits,repeated,not_equal,source_segment;
    pl_u8 reads_source,reads_target,writes_target,reads_accumulator,writes_accumulator;
} pl_x86_string;
/* One element law and its optional repetition: source access precedes target,
 * DF determines the pointer delta, and comparisons terminate on the NEW ZF. */
int pl_x86_string_lower(const pl_x86_instruction *instruction,pl_x86_string *out);
const pl_x86_operand *pl_x86_string_memory(const pl_x86_instruction *instruction,pl_u32 index);

/* MOV ES/SS/DS/FS/GS accepts a 16-bit selector from a GPR or memory. The
 * source access precedes descriptor admission and destination publication;
 * descriptor/interrupt-shadow ownership belongs to the machine boundary. */
int pl_x86_segment_move_supported(const pl_x86_instruction *instruction);
typedef struct { pl_u8 selector,memory,register_index,bits,umip; } pl_x86_selector_read;
/* Visible ES..TR selector snapshot. Memory receives exactly 16 bits; wider
 * GPR destinations zero-extend. LDTR/TR reads have the conditional UMIP cut. */
int pl_x86_selector_read_lower(const pl_x86_instruction *instruction,pl_x86_selector_read *out);

typedef struct { pl_u8 status,memory; } pl_x86_x87_snapshot;
/* No-wait FNSTCW/FNSTSW: one current 16-bit word, no floating exception
 * consumption. EM/TS #NM precedes operand access; AX preserves its parent. */
int pl_x86_x87_snapshot_lower(const pl_x86_instruction *instruction,pl_x86_x87_snapshot *out);

typedef struct { pl_u8 source,ordered,pop;pl_u16 opcode; } pl_x86_x87_compare;
int pl_x86_x87_compare_lower(const pl_x86_instruction *instruction,pl_x86_x87_compare *out);
/* Pure extended-precision relation. Inputs: significand/sign-exponent A,
 * significand/sign-exponent B, empty-stack predicate. Outputs 0..2: EFLAGS
 * CF/PF/ZF, newly raised IE/DE/SF bits, empty predicate. No f64 conversion,
 * rounding, architectural state effect, or serialized operation stream. */
#define PL_X86_X87_RELATION_MAX_NODES 96u
int pl_x86_x87_relation_plan(pl_u32 ordered,pl_u32 alias,pl_arena *arena,pl_plan *out);
/* Exact signed 16/32/64 -> extended representation, independent of PC/RC.
 * Input local 0 is the source word; outputs 0..2 are significand, sign/exp,
 * zero tag. Uses the same physical SSA vocabulary and compaction. */
int pl_x86_x87_integer_plan(pl_u32 bits,pl_arena *arena,pl_plan *out);
typedef struct {pl_u8 bytes;pl_u16 opcode;} pl_x86_x87_integer_load;
int pl_x86_x87_integer_load_lower(const pl_x86_instruction *instruction,pl_x86_x87_integer_load *out);
/* Integer-memory add/subtract. Inputs: ST0 significand/sign-exponent,
 * signed operand, control word, empty predicate. Outputs: significand,
 * sign-exponent, outcome (new exception bits, C1, suppress bit16, tag18..19).
 * Operation is 0 add, 2 subtract, 3 reverse subtract. No state effects. */
#define PL_X86_X87_ARITHMETIC_MAX_NODES 512u
int pl_x86_x87_integer_arithmetic_plan(pl_u32 bits,pl_u32 operation,pl_arena *arena,pl_plan *out);
typedef struct {pl_u8 bytes,operation;pl_u16 opcode;} pl_x86_x87_integer_arithmetic;
int pl_x86_x87_integer_arithmetic_lower(const pl_x86_instruction *instruction,pl_x86_x87_integer_arithmetic *out);
/* Exact raw IEEE32/64 -> extended fields. Output class bits are source
 * denormal(0), signaling NaN(1), zero(2). No quieting/rounding/state effect. */
int pl_x86_x87_ieee_plan(pl_u32 bits,pl_arena *arena,pl_plan *out);
#define PL_X86_X87_MEMORY_RELATION_MAX_NODES 192u
int pl_x86_x87_memory_relation_plan(pl_u32 bits,pl_u32 integer,pl_arena *arena,pl_plan *out);
int pl_x86_x87_zero_relation_plan(pl_arena *arena,pl_plan *out);
typedef struct {pl_u8 memory,integer,bytes,source,ordered,pop,zero;pl_u16 opcode;} pl_x86_x87_status_compare;
int pl_x86_x87_status_compare_lower(const pl_x86_instruction *instruction,pl_x86_x87_status_compare *out);

/* A static lane selection over one or two 128-bit inputs. Coordinates below
 * 16 name the first input; coordinates 16..31 name the second input. Input
 * names and byte coordinates are construction facts, not saved runtime rows.
 * lane_bytes==1 is a whole-byte region translation: start is the saturated
 * byte count, control chooses left/right, and the second region is zero.
 * inputs==0 carries a constant zero result without reading the old register. */
typedef struct {
    pl_u8 lane_bytes;
    pl_u8 start;
    pl_u8 control;
    pl_u8 inputs;
    pl_u8 first_register;
    pl_u8 second_register;
    pl_u8 source_memory;
    pl_u8 identity;
} pl_x86_vector_projection;

int pl_x86_vector_project(const pl_x86_instruction *instruction,
                           pl_x86_vector_projection *out);
pl_u32 pl_x86_vector_project_byte(const pl_x86_vector_projection *projection,
                                  pl_u32 byte);

enum pl_x86_vector_binary_operator {
    PL_X86_VECTOR_BINARY_AND, PL_X86_VECTOR_BINARY_OR,
    PL_X86_VECTOR_BINARY_XOR, PL_X86_VECTOR_BINARY_AND_NOT,
    PL_X86_VECTOR_BINARY_ADD, PL_X86_VECTOR_BINARY_EQUAL
};
enum pl_x86_vector_binary_result {
    PL_X86_VECTOR_BINARY_VALUE, PL_X86_VECTOR_BINARY_IDENTITY,
    PL_X86_VECTOR_BINARY_ZERO, PL_X86_VECTOR_BINARY_ONES
};
typedef struct {
    pl_u8 operation, lane_bytes, source_memory, alias, reverse, result;
} pl_x86_vector_binary;
/* Lower a decoded vector law, substituting equal input coordinates. AND_NOT
 * means first & ~second; source order belongs to this frontend, not a backend. */
int pl_x86_vector_binary_lower(const pl_x86_instruction *instruction,
                               pl_x86_vector_binary *out);

#endif /* X86_SEMANTICS_H */

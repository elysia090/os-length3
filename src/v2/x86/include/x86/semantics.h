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

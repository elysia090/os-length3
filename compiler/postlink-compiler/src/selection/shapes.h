/* Private value shapes for the x86 selection grammar. */
#ifndef POSTLINK_SELECTION_SHAPES_H
#define POSTLINK_SELECTION_SHAPES_H

#include "../internal/x86-selection.h"

/* One arithmetic or comparison instruction can publish both a word and a set
 * of condition observations.  `flag_result_group` carries the members of such a
 * group; when `owner` is PL_X86_GPR_COUNT the operation is a CMP/TEST that
 * publishes no GPR value (`test` selects TEST over CMP), and only booleans are
 * emitted.  The definition of the group shape functions follows later. */
typedef struct {
    pl_u32 owner, booleans, zero_before, members, bits, mode, node, test;
    pl_operand left, right;
} flag_result_group;

/* A CMP/TEST whose comparison feeds an `adc`/`sbb` carry-in: emit the
 * comparison, then the carry-consuming ALU. */
typedef struct {
    pl_u32 destination;
    pl_operand left, right;
    pl_u32 bits, mode;
    pl_operand compare_left, compare_right;
    pl_u32 compare_bits, compare_test;
} carry_alu_group;

typedef struct {
    pl_operand left, right;
    pl_u32 bits, condition;
} test_boolean;

typedef struct {
    pl_u32 destination;
    pl_u32 value_source;
    pl_u32 value_bits;
    pl_u32 scale_log2;
    pl_u32 mode;
    pl_operand right;
} independent_flag_overwrite;

typedef struct {
    pl_u32 destination;
    pl_u32 source;
    pl_u32 mode;
    pl_operand right;
    pl_operand source_publication;
} narrow_flag_transfer;

typedef struct {
    pl_operand current;
    pl_operand compare_right;
    pl_operand compare_left_value;
    pl_operand compare_right_value;
    pl_operand candidate_value;
    pl_u32 candidate_local;
    pl_u32 candidate_is_entry;
    pl_u32 candidate_immediate;
    /* When the candidate arm is a constant whose publication overwrites the
     * entry register the current arm reads, binding the candidate to that
     * publication is a cycle.  The constant is materialised instead and the
     * owner is recorded so the frame can drop the spurious publication
     * dependency. */
    pl_u32 candidate_owner;
    pl_u32 compare_left_local;
    pl_u32 value_bits;
    pl_u32 compare_bits;
    pl_u32 condition;
    pl_u32 has_compare;
    pl_u32 current_flag_node;
    pl_u32 compare_test;
    pl_u32 compare_offset;
    pl_u32 compare_node;
    pl_u32 compare_left_is_current;
    pl_u32 compare_right_is_current;
    pl_u32 compare_left_seed;
    pl_u32 compare_right_seed;
} conditional_select;

typedef struct {
    pl_operand when_true;
    pl_operand when_false;
    pl_operand condition;
    pl_u32 value_bits;
} boolean_select;

typedef struct {
    pl_operand flags;
    pl_u32 condition;
} condition_value;

typedef struct {
    pl_u32 left;
    pl_operand right;
    pl_u32 bits;
    pl_u32 test;
    pl_u32 offset;
    pl_u32 bit_test;
    pl_u32 entry_sources;
    pl_u32 owner_dependencies;
} standalone_flag_publication;

typedef struct {
    pl_operand tree;
    pl_u32 tree_bits;
    pl_operand right;
    pl_u32 bits, test;
    pl_u32 entry_sources, owner_dependencies;
} compare_tree_flag;

typedef struct {
    standalone_flag_publication compare;
    pl_u32 source, bits, mode, zero_mask;
    pl_operand immediate;
} carry_adjustment;

typedef struct {
    conditional_select select;
    pl_operand quotient;
    pl_operand offset;
    pl_operand projected_compare_right;
} quotient_boundary_select;

typedef struct {
    conditional_select select;
    pl_u32 destination;
    pl_u32 side_destination;
    pl_u32 side_bits;
    pl_u32 side_bit;
    pl_operand test_right;
} entry_select_bit_test_frame;

typedef struct {
    pl_u32 destination;
    pl_u32 candidate;
    pl_u32 flag_owner;
    pl_u32 bits;
    pl_u32 flag_bits;
    pl_u32 flag_mode;
    pl_u32 candidate_first;
    conditional_select select;
    pl_operand flag_left;
    pl_operand flag_right;
} shared_flag_select_handoff;

typedef struct {
    pl_u32 local[2];
    pl_u32 count;
    pl_u64 displacement;
    pl_u8 scale_log2[2];
} affine_lea;

typedef struct {
    pl_operand base;
    pl_operand mask;
    pl_operand flag_left;
    pl_operand flag_right;
    pl_u32 bits;
    pl_u32 condition;
    pl_u32 flag_bits;
    pl_u32 flag_mode;
    pl_u32 preserves_carry;
} conditional_or_fold;

typedef struct {
    pl_operand base;
    pl_operand side;
    pl_u64 variable_mask;
    pl_u64 constant;
    pl_u32 bits;
} entry_bit_overlay;

typedef struct {
    pl_u32 destination;
    pl_u32 source;
    pl_u64 mask;
    pl_u64 constant;
    pl_u32 bits;
} masked_entry_affine;

typedef struct {
    pl_u32 base;
    pl_u32 side;
    pl_u32 bits;
    pl_u64 base_constant;
    pl_u64 side_constant;
    pl_u64 final_mask;
} split_entry_overlay;

typedef struct {
    pl_u32 base;
    pl_u32 side;
    pl_u64 low_mask;
    pl_u64 constant;
} low32_entry_overlay;

typedef struct {
    pl_u32 flag_destination;
    pl_u32 sibling_destination;
    pl_u32 scratch;
    pl_u32 source;
    pl_u32 bits;
    pl_u32 flag_group;
    pl_u32 sibling_group;
    pl_operand flag_amount;
    pl_operand sibling_amount;
    pl_operand flag_value;
    pl_operand sibling_value;
} shift_sibling_handoff;

typedef struct {
    pl_u32 parent_destination;
    pl_u32 wide_destination;
    pl_u32 narrow_destination;
    pl_u32 mode;
    pl_operand parent;
    pl_operand right;
} arithmetic_width_handoff;

typedef struct {
    pl_u32 root;
    pl_u32 parent_owner;
    pl_u32 side_owner;
    pl_u32 bits;
    pl_u32 side_mode;
    pl_u32 shift_group;
    pl_u32 root_mode;
    pl_operand parent;
    pl_operand shift_amount;
} shared_diamond_handoff;

typedef struct {
    pl_u32 destination;
    pl_u32 seed_owner;
    pl_u32 parent_owner;
    pl_u32 side_owner;
    pl_u32 seed_bits;
    pl_u32 seed_shift_group;
    pl_u32 parent_shift_group;
    pl_u32 side_inner_shift_group;
    pl_u32 side_outer_shift_group;
    pl_u32 zero_mask;
    pl_u32 flag_owner;
    pl_operand seed_shift_amount;
    pl_operand parent_shift_amount;
    pl_operand side_inner_shift_amount;
    pl_operand side_outer_shift_amount;
} arx_shared_dag_frame;

typedef struct {
    pl_u32 destination;
    pl_u32 mutable_owner;
    pl_u32 independent_owner;
    pl_u32 mutable_shift_group;
    pl_u32 zero_mask;
    pl_u32 flag_owner;
    pl_u32 accumulator_bits;
    pl_u32 independent_bits;
    pl_operand accumulator;
    pl_operand independent;
    pl_operand mutable_shift_amount;
} mutable_xor_frame;

typedef struct {
    pl_u32 inverse;
    pl_u32 low;
    pl_u32 modulus;
    pl_u32 high;
} mul_add_carry_frame;

typedef struct {
    pl_u32 condition_destination;
    pl_u32 condition;
    pl_u32 add_destination;
    pl_operand add_right;
    pl_operand carry_right;
    pl_u32 bits;
} condition_carry_frame;

typedef struct {
    pl_u32 destination;
    pl_u32 dependency_owner;
    pl_u32 bits;
    pl_u32 mode;
    pl_u32 preserves_carry;
    pl_operand seed;
    pl_operand deferred;
    pl_u32 preload_mask;
    pl_u32 scratch_mask;
    pl_u32 tail_present;
    pl_u32 tail_mode;
    pl_operand tail;
} generation_join_handoff;

typedef struct {
    pl_u32 destination;
    pl_u32 mutable_owner;
    pl_u32 sibling_owner;
    pl_u32 bits;
    pl_u32 parent_shift_group;
    pl_u32 mutable_mode;
    pl_u32 sibling_mode;
    pl_u32 root_mode;
    pl_operand accumulator;
    pl_operand parent_shift_amount;
    pl_operand mutable_right;
    pl_operand sibling_right;
} shared_parent_frame;

typedef struct {
    conditional_select select;
    standalone_flag_publication compare;
    pl_u32 destination, members, first;
} select_generation_group;

/* The final flag producer's value tree may read an entry register that another
 * pending publication overwrites.  Its value must then be evaluated before
 * that publication while the flag-setting instruction stays last.  This shape
 * names the destination, the value tree, its scratch and the remaining
 * operand dependency so the measure and write paths can preload the tree with
 * the identical schedule.  Pure; the caller emits and updates the arrays. */
typedef struct {
    pl_u32 destination;
    pl_operand tree;
    pl_u32 tree_bits;
    pl_u32 scratch;
    pl_u32 other_source;
} flag_value_preload;

typedef struct {
    pl_u32 local;
    int is_alu;
    pl_operand seed;
    pl_u32 bits;
    pl_operand amount;
    pl_u32 group;
    pl_operand right;
    pl_u32 mode;
    pl_u32 preserves_carry;
    int is_flag;
} shared_root_consumer;

typedef struct {
    pl_operand seed;
    pl_u32 seed_bits;
    pl_u32 seed_dest;
    pl_u32 copy_dest;
    pl_u32 bits;
    shared_root_consumer dest_consumer;
    shared_root_consumer copy_consumer;
} shared_root_unary_handoff;

typedef struct {
    pl_u32 destination;
    pl_u32 candidate;
    pl_u32 compare_owner;
    pl_u32 value_bits;
    pl_u32 compare_bits;
    pl_u32 condition;
    pl_u32 test;
    pl_operand current;
    pl_operand tree;
    pl_operand right;
} compare_tree_select_frame;

typedef struct {
    pl_u32 owner;
    pl_u32 duplicate;
    pl_u32 right_owner;
    pl_operand right;
} shared_sub_frame;

typedef struct {
    pl_u32 changed;
    pl_u32 left;
    pl_operand right;
    pl_u32 bits;
    pl_u32 condition;
    pl_u32 test;
} compare_branch_operands;

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 scratch;
    pl_u32 producers;
    pl_u32 bits;
    pl_operand right;
} subtract_handoff;

typedef struct {
    pl_u32 owner;
    pl_u32 consumer;
    pl_u32 plain;
    pl_u32 consumer_bits;
    conditional_select select;
    pl_operand consumer_right;
} transient_owner_frame;

typedef struct {
    pl_operand seed;
    pl_u32 seed_bits;
    pl_u32 seed_dest;
    pl_u32 copy_dest;
    pl_u32 bits;
    pl_operand amount[2];
    pl_u32 group[2];
} shared_root_shift_handoff;

typedef struct {
    pl_u32 zero;
    pl_u32 plain;
    pl_u32 anchor;
    pl_u32 flag_bits;
    /* At most one value publication may be the normalized single-bit
     * projection `((x >> p) & 1) << q` (optionally inverted).  It is emitted
     * as a self-zero, a bit test and a conditional move so its dependency
     * span is the two flag edges instead of the destructive shift tree's
     * copy/shift/mask/xor chain.  PL_X86_GPR_COUNT means absent. */
    pl_u32 projection;
    pl_operand projection_source;
    pl_u32 projection_from;
    pl_u32 projection_to;
    pl_u32 projection_inverse;
    pl_u32 projection_bits;
    pl_u32 projection_source_local;
    pl_u32 projection_input_local;
    pl_u32 projection_mask_local;
} zero_flag_frame;

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 plain;
    pl_u32 bits;
    pl_u32 group;
    pl_operand amount;
} shift_handoff_frame;

typedef struct {
    pl_u32 owner;
    pl_u32 shared;
    pl_u32 shared_bits;
    pl_u32 owner_bits;
    pl_u32 owner_mode;
    pl_u32 owner_preserves_carry;
    pl_u32 compare_left;
    pl_u32 compare_right;
    pl_u32 compare_bits;
    pl_u32 condition;
    pl_u32 test;
    pl_u32 has_branch;
    pl_operand shared_value;
    pl_operand owner_right;
} shared_owner_frame;

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 bits;
    pl_u32 mode;
    pl_u32 preserves_carry;
    pl_u32 condition;
    pl_operand value;
    pl_operand left;
    pl_operand right;
} value_predicate_frame;

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 bits;
    pl_u32 mode;
    pl_u32 condition;
    pl_u32 compare_left;
    pl_u32 compare_right;
    pl_u32 test;
    pl_operand transient;
    pl_operand replacement;
    pl_operand right;
} compare_handoff_frame;

typedef struct {
    pl_u32 tested, copy_source, test_bits, condition;
    pl_u64 mask;
} mask_flag_branch;

typedef struct {
    pl_u32 narrow, wide;
    pl_operand word;
} signed_word_handoff;

typedef struct {
    pl_u32 constant_local;
    pl_u32 destination;
    pl_u32 source;
    pl_u64 constant;
} published_wide_add;

/* ---- Transient seed before a flag producer ----
 *
 * A final `X86_ALU` publication can have one operand that is an intermediate
 * reading an entry register which another pending publication overwrites.
 * Emitting the flag producer first would lose the flags; emitting the
 * clobbering publication first would lose the entry.  Capture the intermediate
 * once in a transient output coordinate whose final value is independent, then
 * run the other publications, then the flag producer, then close the transient
 * with a flag-preserving (const/copy/insert) publication of its own. */

typedef struct {
    pl_u32 flag_node;
    pl_u32 destination;
    pl_u32 transient;
    pl_u32 seed_bits;
    pl_u32 bits, mode, preserves_carry;
    pl_operand seed;
    pl_u32 others;
} transient_seed_frame;

/* ---- Consumed flag-result frame ----
 *
 * The final observable conditions can belong to an ALU result that is not
 * itself an architectural output: the result feeds later publications.  Emit
 * the independent publications first, then the ALU that produces the observed
 * flags, then only affine or copy publications over that result.  LEA and MOV
 * preserve the arithmetic flags, so the emitted flag word is the ALU's own.
 * This covers the common `sub`/`add` result whose value is consumed by a
 * following address computation while the flags remain live. */

typedef struct {
    pl_u32 flag_node;
    pl_u32 result_node;
    pl_u32 result_register;
    pl_operand left, right;
    pl_u32 bits, mode, preserves_carry;
    pl_u32 before_mask;
    pl_u32 after_mask;
} consumed_flag_frame;

#endif

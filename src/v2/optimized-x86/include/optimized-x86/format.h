/* Proof vocabulary encoded with standard ELF symbols and GNU build-id. */

#ifndef OPTIMIZED_X86_FORMAT_H
#define OPTIMIZED_X86_FORMAT_H

#include <support/types.h>

#define OX_PROOF_VERSION 3u
#define OX_MACHINE_ABI_VERSION 1u

/* Ordinary ET_DYN shared objects have e_entry == 0.  Their callable roots are
 * exported functions and loader metadata, so no function rank is privileged
 * as a process entry. */
#define OX_PROOF_NO_ENTRY_FUNCTION (~0ull)

#define OX_PROOF_TOTAL_COORDINATES  (1u << 0u)
#define OX_PROOF_EXACT_FAULT_CUTS   (1u << 1u)
#define OX_PROOF_DIRECT_CONTROL     (1u << 2u)
#define OX_PROOF_NO_RUNTIME_DECODE  (1u << 3u)
#define OX_PROOF_NO_RESIDUAL_TABLES (1u << 4u)
#define OX_PROOF_STATIC_COST_NONREGRESSED (1u << 5u)
#define OX_PROOF_JOINT_PHYSICAL_MINIMUM    (1u << 6u)
#define OX_PROOF_REQUIRED_FLAGS                                      \
    (OX_PROOF_TOTAL_COORDINATES | OX_PROOF_EXACT_FAULT_CUTS         \
     | OX_PROOF_DIRECT_CONTROL | OX_PROOF_NO_RUNTIME_DECODE         \
     | OX_PROOF_NO_RESIDUAL_TABLES                              \
     | OX_PROOF_STATIC_COST_NONREGRESSED                         \
     | OX_PROOF_JOINT_PHYSICAL_MINIMUM)

/* Every value is the st_value of a global STT_NOTYPE, SHN_ABS symbol in the
 * ordinary SHT_SYMTAB. A stripped output has destroyed its proof. */
#define OX_SYMBOL_PROOF_VERSION      "__postlink_proof_version"
#define OX_SYMBOL_MACHINE_ABI        "__postlink_machine_abi"
#define OX_SYMBOL_FLAGS              "__postlink_proof_flags"
#define OX_SYMBOL_SOURCE_SHA256_0    "__postlink_source_sha256_0"
#define OX_SYMBOL_SOURCE_SHA256_1    "__postlink_source_sha256_1"
#define OX_SYMBOL_SOURCE_SHA256_2    "__postlink_source_sha256_2"
#define OX_SYMBOL_SOURCE_SHA256_3    "__postlink_source_sha256_3"
#define OX_SYMBOL_SOURCE_BYTES       "__postlink_source_bytes"
#define OX_SYMBOL_ENTRY_FUNCTION     "__postlink_entry_function"
#define OX_SYMBOL_FUNCTION_COUNT     "__postlink_function_count"
#define OX_SYMBOL_COORDINATE_COUNT   "__postlink_coordinate_count"
#define OX_SYMBOL_DIRECT_COUNT       "__postlink_direct_count"
#define OX_SYMBOL_FAULT_COUNT        "__postlink_fault_count"
#define OX_SYMBOL_INPUT_SPAN         "__postlink_input_span"
#define OX_SYMBOL_OUTPUT_SPAN        "__postlink_output_span"
#define OX_SYMBOL_INPUT_WORK         "__postlink_input_work"
#define OX_SYMBOL_OUTPUT_WORK        "__postlink_output_work"
#define OX_SYMBOL_MINIMUM_SPAN       "__postlink_minimum_span"
#define OX_SYMBOL_MINIMUM_WORK       "__postlink_minimum_work"
#define OX_SYMBOL_PARETO_COMPLETE    "__postlink_pareto_complete"
#define OX_SYMBOL_INPUT_CODE_BYTES   "__postlink_input_code_bytes"
#define OX_SYMBOL_OUTPUT_CODE_BYTES  "__postlink_output_code_bytes"

#define OX_PROOF_SYMBOL_COUNT 22u
#define OX_BUILD_ID_MAX_BYTES 64u

#define OX_ERROR_ELF       (-80)
#define OX_ERROR_RANGE     (-81)
#define OX_ERROR_PROOF     (-82)
#define OX_ERROR_DUPLICATE (-83)
#define OX_ERROR_BUILD_ID  (-84)

#endif /* OPTIMIZED_X86_FORMAT_H */

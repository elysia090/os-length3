/* Independently checkable contract carried by one ordinary optimized ELF. */

#ifndef OPTIMIZED_X86_PROOF_H
#define OPTIMIZED_X86_PROOF_H

#include <optimized-x86/format.h>

typedef struct {
    pl_u64 proof_version;
    pl_u64 machine_abi;
    pl_u64 flags;
    pl_u64 source_sha256[4];
    pl_u64 source_bytes;
    pl_u64 entry_function;
    pl_u64 function_count;
    pl_u64 coordinate_count;
    pl_u64 direct_count;
    pl_u64 fault_count;
    pl_u64 input_span;
    pl_u64 output_span;
    pl_u64 input_work;
    pl_u64 output_work;
    /* Independently derived componentwise lower bounds. pareto_complete=1
     * means the emitted candidate attains both; 2 means an exact nonjoint
     * Pareto member was selected and its actual costs are output_span/work. */
    pl_u64 minimum_span;
    pl_u64 minimum_work;
    pl_u64 pareto_complete;
    pl_u64 input_code_bytes;
    pl_u64 output_code_bytes;
    pl_u8 build_id[OX_BUILD_ID_MAX_BYTES];
    pl_u32 build_id_bytes;
} ox_proof;

/* The proof is necessary but never advisory: failure rejects publication. */
int ox_proof_validate(const ox_proof *proof);

/* Static work, span and executable bytes may not regress. Native speed is a
 * paired empirical publication gate, not a value an ELF may self-report.
 * Whole-file size improvement is checked by the reader against source_bytes. */
int ox_proof_cost_nonregresses(const ox_proof *proof);

#endif /* OPTIMIZED_X86_PROOF_H */

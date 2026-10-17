/* Total decode outcomes and architectural fault vectors. */

#ifndef X86_FAULT_H
#define X86_FAULT_H

#define PL_ERROR_X86          (-40)
#define PL_ERROR_X86_MAP      (-41)
#define PL_ERROR_X86_CAPACITY (-42)

enum pl_x86_decode_status {
    PL_X86_DECODE_VALID = 0,
    PL_X86_DECODE_INVALID,
    PL_X86_DECODE_TOO_LONG,
    PL_X86_DECODE_FETCH_FAULT,
};

#define PL_X86_FAULT_DIVIDE  0u
#define PL_X86_FAULT_DEBUG   1u
#define PL_X86_FAULT_INVALID 6u
#define PL_X86_FAULT_GENERAL 13u
#define PL_X86_FAULT_PAGE    14u

#endif /* X86_FAULT_H */

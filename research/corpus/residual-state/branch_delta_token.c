#include <stdint.h>

/* A branch has at most two ordered outcomes.  Store the selected outcome in
 * bit zero and the signed relative target in the following 32 bits.  This is
 * injective over every (outcome, relative_target) pair in the stated domain. */
uint64_t branch_delta_token(uint32_t outcome, int32_t relative_target)
{
    return ((uint64_t)(uint32_t)relative_target << 1)
         | (uint64_t)(outcome & 1u);
}

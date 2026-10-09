#ifndef MACHINE_CONTROL_H
#define MACHINE_CONTROL_H
#include <support/types.h>
/* Compiled return transaction: low16 is caller/callee parameter release;
 * bits16..17 select 64(default),16,32-bit stack slots. No opcode enters C. */
#define MACHINE_RETURN_DISCARD_MASK 65535u
#define MACHINE_RETURN_WIDTH_SHIFT 16u
static inline pl_u32 machine_return_bytes(pl_u32 word)
{
    if(word&~0x3ffffu)return 0u;
    pl_u32 rank=word>>MACHINE_RETURN_WIDTH_SHIFT;return rank==0u?8u:rank==1u?2u:rank==2u?4u:0u;
}
static inline pl_u32 machine_return_word(pl_u32 bytes,pl_u32 discard)
{
    if((bytes!=2u&&bytes!=4u&&bytes!=8u)||discard>65535u)return ~0u;
    return discard|((bytes==2u?1u:bytes==4u?2u:0u)<<MACHINE_RETURN_WIDTH_SHIFT);
}
/* Far transfer takes a decoded offset/selector, not an opcode or source EA.
 * Low2 bits select 16/32/64-bit offset/ordinary stack slots; bit2 is CALL.
 * A 64-bit call gate supplies its own target and forces64-bit stack slots. */
static inline pl_u32 machine_transfer_bytes(pl_u32 word)
{return word&~7u?0u:(word&3u)==0u?2u:(word&3u)==1u?4u:(word&3u)==2u?8u:0u;}
static inline pl_u32 machine_transfer_word(pl_u32 bytes,pl_u32 call)
{return (bytes!=2u&&bytes!=4u&&bytes!=8u)||call>1u?~0u:(bytes==2u?0u:bytes==4u?1u:2u)|(call<<2u);}
#endif

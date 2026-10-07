#ifndef CHECK_X87_OBSERVATION_H
#define CHECK_X87_OBSERVATION_H
#include <machine/state.h>
#include <string.h>
/* FXSAVE's data lanes are logical ST(i), but its occupancy bits and the
 * machine's payload/tag arrays name physical registers. Test input only. */
static inline pl_u64 check_x87_read(const void *at,pl_u32 count)
{pl_u64 value=0u;for(pl_u32 i=0u;i<count;++i)value|=(pl_u64)((const pl_u8 *)at)[i]<<(i*8u);return value;}
static inline void check_x87_project(machine_state *cpu,const pl_u8 *image)
{
    cpu->x87_control=(pl_u16)check_x87_read(image,2u);cpu->x87_status=(pl_u16)check_x87_read(image+2u,2u);
    cpu->x87_opcode=(pl_u16)check_x87_read(image+6u,2u);cpu->x87_ip=check_x87_read(image+8u,8u);
    cpu->x87_dp=check_x87_read(image+16u,8u);cpu->mxcsr=(pl_u32)check_x87_read(image+24u,4u);cpu->x87_tag=0u;
    pl_u32 top=(cpu->x87_status>>11u)&7u;
    for(pl_u32 rank=0u;rank<8u;++rank){pl_u32 logical=(rank+8u-top)&7u;
        pl_u64 fraction=check_x87_read(image+32u+logical*16u,8u);
        pl_u16 se=(pl_u16)check_x87_read(image+40u+logical*16u,2u);pl_u32 exponent=se&0x7fffu;
        pl_u32 tag=!(image[4u]&(1u<<rank))?3u:!exponent&&!fraction?1u:
            !exponent||exponent==0x7fffu||!(fraction>>63u)?2u:0u;
        cpu->x87_tag=(pl_u16)(cpu->x87_tag|(tag<<(rank*2u)));
        cpu->x87_significand[rank]=fraction;cpu->x87_sign_exponent[rank]=se;
    }
    memcpy(cpu->xmm,image+160u,sizeof cpu->xmm);
}
#endif

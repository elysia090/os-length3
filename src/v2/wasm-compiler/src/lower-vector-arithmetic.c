#include "cut-internal.h"

pl_u32 cut_vector_add_width(const pl_x86_instruction *instruction)
{
    pl_u32 kind=(pl_u32)(instruction->machine_argument&255u);
    if(kind==4u)return 32u;
    if(kind!=10u)return 0u;
    switch(instruction->machine_argument>>32u) {
    case 15u:return 64u;
    case 56u:return 8u;
    case 57u:return 16u;
    default:return 0u;
    }
}

void cut_lower_vector_add(cut_lowering *cut,const pl_x86_instruction *instruction,pl_u32 width)
{
    /* Width is the admitted 8/16/32-bit element width, not a guest value.
     * Clear each lane's top bit before addition: lower sums cannot carry
     * beyond that lane. Restore the top inputs with XOR, modulo 2^width. */
    pl_u64 top=width==8u?0x8080808080808080ull
        :width==16u?0x8000800080008000ull:0x8000000080000000ull;
    pl_u64 first=width==8u?0x0101010101010101ull
        :width==16u?0x0001000100010001ull:0x0000000100000001ull;
    int equal=!(instruction->machine_argument&(1ull<<24u))
        && instruction->operands[0].value.reg.index==instruction->operands[1].value.reg.index;
    pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
    for(pl_u32 half=0u;half<2u;++half) {
        pl_u32 local=half?CUT_RIGHT:CUT_LEFT;
        if(equal) {
            /* Doubling discards each lane's old high bit. A word shift
             * followed by clearing lane bit zero is exactly that result. */
            cut_get(cut,local);cut_const(cut,1u);cut_op(cut,0x86u);
            cut_const(cut,~first);cut_op(cut,0x83u);
        } else {
            cut_load(cut,offset+half*8u);cut_set(cut,CUT_VALUE);
            cut_get(cut,CUT_VALUE);cut_const(cut,~top);cut_op(cut,0x83u);
            cut_get(cut,local);cut_const(cut,~top);cut_op(cut,0x83u);cut_op(cut,0x7cu);
            cut_get(cut,CUT_VALUE);cut_get(cut,local);cut_op(cut,0x85u);
            cut_const(cut,top);cut_op(cut,0x83u);cut_op(cut,0x85u);
        }
        cut_set(cut,local);
    }
}

#include "../src/cut-internal.h"
#include <stdio.h>
#include <string.h>
int main(void)
{
    // Pure one-node SSA, not a guest fixture. Exact bytes make the old dual
    // comparison/extraction path red even when its numerical results agree.
    const pl_u8 cf[]={0x20,7,0x20,8,0x54,0xad,0x21,35,0x20,35,0x21,4};
    const pl_u8 zf[]={0x20,7,0x20,8,0x51,0xad,0x21,35,0x20,35,0x21,4};
    const pl_u8 both[]={0x20,7,0x20,8,0x54,0xad,0x20,7,0x20,8,0x51,0xad,0x42,6,0x86,0x84,0x21,35,
        0x20,35,0x42,1,0x83,0x21,4,0x20,35,0x42,6,0x88,0x42,1,0x83,0x21,5};
    pl_node node={.opcode=PL_OPCODE_X86_COMPARE,.argument_at=0u,.argument_count=4u};
    pl_operand args[]={{PL_OPERAND_CONST,0u},{PL_OPERAND_LOCAL,0u},{PL_OPERAND_LOCAL,1u},{PL_OPERAND_CONST,64u|(3u<<8u)}};
    pl_operand locals[PL_X86_LOCAL_COUNT]={{0}};pl_plan plan={.nodes=&node,.node_count=1u,.arguments=args,.argument_count=4u,.locals=locals,.local_count=5u};
    const pl_u32 inputs[PL_X86_LOCAL_COUNT]={4u,5u},outputs[]={1u,2u};
    for(pl_u32 mode=0u;mode<3u;++mode){
        pl_u8 bytes[256];wasm_writer writer={.bytes=bytes,.capacity=sizeof bytes};cut_lowering c={.writer=&writer};
        locals[0]=(pl_operand){PL_OPERAND_PROJECTION,256u|(mode==1u?4u:2u)};
        locals[1]=(pl_operand){PL_OPERAND_PROJECTION,256u|4u};
        cut_emit_scalar_projection(&c,&plan,inputs,32u,outputs,mode==2u?2u:1u);
        const pl_u8 *expected=mode==0u?cf:mode==1u?zf:both;size_t size=mode==2u?sizeof both:sizeof cf;
        if(writer.error||writer.used!=size||memcmp(bytes,expected,size)){
            fprintf(stderr,"projected CMP mode=%u actual=%llu expected=%zu error=%d\n",mode,(unsigned long long)writer.used,size,writer.error);return 1;}
    }
    for(pl_u32 projection=0u;projection<256u;++projection){if(projection==2u||projection==4u)continue;
        pl_u8 bytes[256];memset(bytes,0xa5,sizeof bytes);wasm_writer writer={.bytes=bytes,.capacity=sizeof bytes};cut_lowering c={.writer=&writer};
        locals[0]=(pl_operand){PL_OPERAND_PROJECTION,256u|projection};cut_emit_scalar_projection(&c,&plan,inputs,32u,outputs,1u);
        if(writer.error!=WASM_COMPILER_ERROR_GRAMMAR||writer.used||bytes[0]!=0xa5u)return 1;
    }
    locals[0]=(pl_operand){PL_OPERAND_PROJECTION,256u|2u};
    for(pl_u32 count=1u;count<=PL_X86_LOCAL_COUNT;++count){pl_u8 bytes[256];wasm_writer writer={.bytes=bytes,.capacity=sizeof bytes};cut_lowering c={.writer=&writer};
        plan.local_count=count;args[2]=count==1u?(pl_operand){PL_OPERAND_CONST,0u}:(pl_operand){PL_OPERAND_LOCAL,1u};
        cut_emit_scalar_projection(&c,&plan,inputs,32u,outputs,1u);
        if(writer.error||!writer.used||(count>1u&&(writer.used!=sizeof cf||memcmp(bytes,cf,sizeof cf))))return 1;
    }
    plan.local_count=PL_X86_LOCAL_COUNT+1u;pl_u8 bytes[256]={0};wasm_writer writer={.bytes=bytes,.capacity=sizeof bytes};cut_lowering c={.writer=&writer};
    cut_emit_scalar_projection(&c,&plan,inputs,32u,outputs,1u);if(writer.error!=WASM_COMPILER_ERROR_GRAMMAR||writer.used)return 1;
    puts("projected CMP: exact CF-only/ZF-only/both bodies;254 unsupported projections,1..19 input slots and bounded overflow; untouched refusals");return 0;
}

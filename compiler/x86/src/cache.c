/* Cache-barrier source/effect law shared by native and translated execution. */
#include <x86/semantics.h>
int pl_x86_cache_barrier_supported(const pl_x86_instruction *i)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_PRIVILEGED;
    return i&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY&&i->flow==PL_X86_FLOW_SYSTEM
        &&i->machine_operation==PL_X86_MACHINE_MEMORY_ORDER&&(i->machine_argument==2u||i->machine_argument==3u)
        &&i->opcode==(i->machine_argument==2u?9u:8u)&&!i->visible_operand_count&&(i->flags&required)==required
        &&!(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY))
        &&i->source_bytes&&i->source_bytes<=15u&&i->length==i->source_bytes&&i->fallthrough-i->rip==i->length;
}

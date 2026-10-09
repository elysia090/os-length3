#include <vm/control.h>
#include <machine/control.h>
#include "memory-internal.h"
#include "segments-internal.h"
#include <stddef.h>
static int canonical(pl_u64 x){return x>>47u==0u||x>>47u==0x1ffffu;}
static machine_result fault(pl_u8 *port,const machine_state *s,pl_u32 vector,pl_u32 error)
{
    vm_memory_store(port+offsetof(machine_memory_port,fault_address),s->rip,8u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_vector),vector,4u);vm_memory_store(port+offsetof(machine_memory_port,fault_error),error,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}
static int origin(const machine_state *s,const machine_segments *g)
{
    if(!s||!g)return 0;
    pl_u32 cpl=(pl_u32)s->system[MACHINE_SYSTEM_CS]&3u,cs=g->cache[MACHINE_SEGMENT_CS].attributes,dpl=(cs>>5u)&3u;
    return g->version==MACHINE_SEGMENTS_ABI_VERSION&&g->interrupt_shadow<=MACHINE_SHADOW_STI
        &&(cs&0x2098u)==0x2098u&&!(cs&(0x4000u|MACHINE_SEGMENT_UNUSABLE))
        &&(!cpl||((cs&4u)?dpl<=cpl:dpl==cpl))&&!(s->rflags&0x60100u)&&!(s->cr4&(1ull<<23u));
}
machine_result vm_far_transfer(vm_memory *m,pl_u32 at,machine_state *s,machine_segments *g,vm_fault_delivery *f,
    pl_u32 word,pl_u64 input_target,pl_u32 input_selector,pl_u64 next_rip)
{
    vm_memory_abort(m);pl_u32 bytes=machine_transfer_bytes(word),call=(word>>2u)&1u;
    if(!m||!m->bytes||!m->generation||!f||!origin(s,g)||(at&7u)||(pl_u64)at+sizeof(machine_memory_port)>m->reserved_bytes
        ||!bytes||input_selector>65535u||next_rip-s->rip<1u||next_rip-s->rip>15u){
        if(f)*f=(vm_fault_delivery){0};
        return MACHINE_RESULT_ENTRY_MAP;
    }
    pl_u8 *p=m->bytes+at;if(vm_memory_load(p,8u)!=m->generation){*f=(vm_fault_delivery){0};return MACHINE_RESULT_STALE_GENERATION;}
    pl_u32 cpl=(pl_u32)s->system[MACHINE_SYSTEM_CS]&3u;
    if(!f->stage){*f=(vm_fault_delivery){.generation=m->generation,.kind=VM_EVENT_TRANSFER,.vector=word,.stage=1u,
        .context={s->rip,s->cr0,s->cr3,s->cr4,s->efer},.frame={s->system[MACHINE_SYSTEM_SS]&65535u,s->registers[4],s->rflags,
            s->system[MACHINE_SYSTEM_CS]&65535u,next_rip,input_target},.gate_type=input_selector,
        .selector=input_selector,.target=input_target,.stack=s->registers[4],.words=call?2u:0u};}
    else if(f->kind!=VM_EVENT_TRANSFER||f->stage>6u||f->generation!=m->generation||f->vector!=word||f->gate_type!=input_selector
        ||f->frame[5]!=input_target||f->frame[4]!=next_rip||f->frame[0]!=(s->system[MACHINE_SYSTEM_SS]&65535u)||f->frame[1]!=s->registers[4]
        ||f->frame[2]!=s->rflags||f->frame[3]!=(s->system[MACHINE_SYSTEM_CS]&65535u)||f->context[0]!=s->rip||f->context[1]!=s->cr0
        ||f->context[2]!=s->cr3||f->context[3]!=s->cr4||f->context[4]!=s->efer){*f=(vm_fault_delivery){0};return MACHINE_RESULT_ENTRY_MAP;}
    machine_result result=0u;vm_mmu_context supervisor={s->cr0,s->cr3,s->cr4,s->efer,0u};
    if(f->stage==1u){pl_u64 raw;result=vm_descriptor_read(m,at,s,g,input_selector,0u,&f->descriptor_address,&raw);if(result)goto done;
        pl_u32 access=(pl_u32)(raw>>40u)&255u,error=input_selector&0xfffcu;
        if(access&16u){
            if(!(access&8u)||((access&4u)?((access>>5u)&3u)>cpl:((access>>5u)&3u)!=cpl||(input_selector&3u)>cpl)){
                result=fault(p,s,13u,error);goto done;}
            if(!(access&128u)){result=fault(p,s,11u,error);goto done;}
            f->code=vm_segment_cache_decode(raw);f->descriptor_access=access;f->selector=(input_selector&~3u)|cpl;f->stage=4u;
        }else{
            if((access&31u)!=12u||((access>>5u)&3u)<cpl||((access>>5u)&3u)<(input_selector&3u)){result=fault(p,s,13u,error);goto done;}
            if(!(access&128u)){result=fault(p,s,11u,error);goto done;}
            pl_u64 limit=input_selector&4u?g->cache[MACHINE_SEGMENT_LDTR].limit:s->system[MACHINE_SYSTEM_GDTR_LIMIT];
            if((pl_u64)(input_selector&0xfff8u)+15u>limit){result=fault(p,s,13u,error);goto done;}
            f->target=(raw&65535u)|((raw>>48u)<<16u);f->selector=(pl_u32)(raw>>16u)&65535u;f->stage=2u;
        }
    }
    if(f->stage==2u){result=vm_mmu_access(m,at,&supervisor,f->descriptor_address+8u,8u,MACHINE_MEMORY_READ,0u);if(result)goto done;
        pl_u64 high=vm_memory_load(p+offsetof(machine_memory_port,value),8u);
        if(high>>32u){result=fault(p,s,13u,input_selector&0xfffcu);goto done;}
        f->target|=high<<32u;f->stage=3u;
    }
    if(f->stage==3u){pl_u64 raw;result=vm_descriptor_read(m,at,s,g,f->selector,0u,&f->descriptor_address,&raw);if(result)goto done;
        pl_u32 access=(pl_u32)(raw>>40u)&255u,dpl=(access>>5u)&3u,error=f->selector&0xfffcu;
        if((access&24u)!=24u||dpl>cpl||(!call&&!(access&4u)&&dpl!=cpl)){result=fault(p,s,13u,error);goto done;}
        if(!(access&128u)){result=fault(p,s,11u,error);goto done;}
        f->code=vm_segment_cache_decode(raw);f->descriptor_access=access|256u;
        f->selector=(f->selector&~3u)|(call&&!(access&4u)?dpl:cpl);f->words=call&&dpl<cpl&&!(access&4u)?4u:call?2u:0u;
        f->stage=4u;
    }
    if(f->stage==4u){pl_u32 error=f->selector&0xfffcu;
        if((f->code.attributes&0x6000u)==0x6000u){result=fault(p,s,13u,error);goto done;}
        if(!(f->code.attributes&0x2000u)){result=MACHINE_RESULT_ENTRY_MAP;goto done;}
        result=vm_descriptor_accessed(m,at,s,f->descriptor_address,f->descriptor_access&255u);if(result)goto done;
        f->stage=5u;
    }
    if(f->stage==5u){
        if(!call&&!canonical(f->target)){result=fault(p,s,13u,0u);goto done;}
        if(f->words==4u){const machine_segment_cache *tss=&g->cache[MACHINE_SEGMENT_TR];pl_u32 rank=f->selector&3u,offset=4u+rank*8u;
            if((tss->attributes&MACHINE_SEGMENT_UNUSABLE)||(tss->attributes&0x9fu)!=0x8bu||tss->limit<103u
                ||tss->base>~0ull-offset-7u||!canonical(tss->base+offset)||!canonical(tss->base+offset+7u)){result=MACHINE_RESULT_ENTRY_MAP;goto done;}
            result=vm_mmu_access(m,at,&supervisor,tss->base+offset,8u,MACHINE_MEMORY_READ,0u);if(result)goto done;
            f->stack=vm_memory_load(p+offsetof(machine_memory_port,value),8u);
        }
        f->stage=6u;
    }
    bytes=f->descriptor_access&256u?8u:bytes;
    if(f->words){pl_u64 total=(pl_u64)f->words*bytes;if(f->stack<total||!canonical(f->stack)||!canonical(f->stack-total)){result=fault(p,s,12u,0u);goto done;}
        vm_mmu_context stack={s->cr0,s->cr3,s->cr4,s->efer,f->selector&3u};
        while(f->pushed<f->words){pl_u32 source=f->words==4u?(f->pushed<2u?f->pushed:f->pushed+1u):f->pushed+3u;
            pl_u64 value=f->frame[source];if(bytes<8u)value&=~0ull>>(64u-bytes*8u);
            result=vm_mmu_access(m,at,&stack,f->stack-(f->pushed+1u)*bytes,bytes,MACHINE_MEMORY_WRITE|MACHINE_MEMORY_STACK,value);if(result)goto done;++f->pushed;
        }
    }
    // CALL's frame RAM effects precede a noncanonical target #GP, while the
    // architectural RSP/CS/RIP remain uncommitted on that fault.
    if(!canonical(f->target)){result=fault(p,s,13u,0u);goto done;}
    if(f->words)s->registers[4]=f->stack-(pl_u64)f->words*bytes;
    if(f->words==4u){s->system[MACHINE_SYSTEM_SS]=f->selector&3u;g->cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0u,MACHINE_SEGMENT_UNUSABLE|((f->selector&3u)<<5u)};}
    s->system[MACHINE_SYSTEM_CS]=f->selector;g->cache[MACHINE_SEGMENT_CS]=f->code;s->rip=f->target;g->interrupt_shadow=0u;
done:
    if(result!=MACHINE_RESULT_BARRIER)*f=(vm_fault_delivery){0};
    return result;
}

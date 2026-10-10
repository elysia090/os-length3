#include <vm/dma.h>
#include <vm/mmu.h>
#include "memory-internal.h"
#include <stdint.h>
#include <stddef.h>
machine_result vm_dma_check(vm_memory *m,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u32 access)
{
    if(!m||!m->bytes||!m->generation||m->reservation.parts||(port&7u)
        ||(pl_u64)port+sizeof(machine_memory_port)>m->reserved_bytes||!bytes||bytes>VM_DMA_MAX_BYTES
        ||(access!=1u&&access!=2u)||address>=1ull<<40u||bytes>(1ull<<40u)-address)return MACHINE_RESULT_ENTRY_MAP;
    if(vm_memory_load(m->bytes+port,8u)!=m->generation)return MACHINE_RESULT_STALE_GENERATION;
    for(pl_u32 done=0u;done<bytes;){pl_u64 at=address+done;pl_u32 n=4096u-(pl_u32)(at&4095u);if(n>bytes-done)n=bytes-done;
        const vm_memory_page *p=vm_memory_find(m,at);
        if(!p){vm_memory_store(m->bytes+port+offsetof(machine_memory_port,request_address),at,8u);
            vm_memory_store(m->bytes+port+offsetof(machine_memory_port,request_bytes),n,4u);
            vm_memory_store(m->bytes+port+offsetof(machine_memory_port,request_access),access|VM_MMU_PHYSICAL_REQUEST,4u);
            return MACHINE_RESULT_BARRIER;}
        if(p->kind!=VM_MEMORY_RAM||(p->rights&access)!=access||(pl_u64)p->offset+4096u>m->byte_count)return MACHINE_RESULT_ENTRY_MAP;
        done+=n;
    }
    return 0u;
}
static int private_bytes(const vm_memory *m,const pl_u8 *p,pl_u32 bytes)
{
    uintptr_t at=(uintptr_t)p,base=(uintptr_t)m->bytes;
    return p&&bytes<=UINTPTR_MAX-at&&m->byte_count<=UINTPTR_MAX-base
        &&(at+bytes<=base||base+m->byte_count<=at);
}
static machine_result transfer(vm_memory *m,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u8 *output,const pl_u8 *input)
{
    machine_result status=vm_dma_check(m,port,address,bytes,input?2u:1u);if(status)return status;
    if(!private_bytes(m,input?input:output,bytes))return MACHINE_RESULT_ENTRY_MAP;
    for(pl_u32 done=0u;done<bytes;){pl_u64 at=address+done;pl_u32 n=4096u-(pl_u32)(at&4095u);if(n>bytes-done)n=bytes-done;
        const vm_memory_page *p=vm_memory_find(m,at);pl_u32 offset=p->offset+(pl_u32)(at&4095u);
        if(input){vm_memory_before_write(m,offset,n);for(pl_u32 j=0u;j<n;++j)m->bytes[offset+j]=input[done+j];m->write_touched=1u;}
        else for(pl_u32 j=0u;j<n;++j)output[done+j]=m->bytes[offset+j];
        done+=n;
    }
    return 0u;
}
machine_result vm_dma_read(vm_memory *m,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u8 *target)
{return transfer(m,port,address,bytes,target,NULL);}
machine_result vm_dma_write(vm_memory *m,pl_u32 port,pl_u64 address,pl_u32 bytes,const pl_u8 *source)
{return transfer(m,port,address,bytes,NULL,source);}

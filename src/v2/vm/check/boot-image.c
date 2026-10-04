/* Immutable physical image admission, not filesystem or Linux boot emulation. */
#include <vm/supply.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[32768], header[4096], page[4096];
static vm_memory_page pages[4];
static vm_memory_branch branches[3];
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"boot-image: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)

static void pending(vm_page_supply *supply, vm_memory *memory,
                    const machine_state *state, pl_u64 address)
{
    vm_memory_store(arena,9u,8u); vm_memory_store(arena+32u,address,8u);
    vm_memory_store(arena+40u,8u,4u); vm_memory_store(arena+44u,18u,4u);
    vm_supply_capture(supply,memory,state,0u,MACHINE_RESULT_BARRIER);
}

int main(void)
{
    vm_boot boot = {.header=header,.ram_bytes=0x8000000u};
    vm_boot_source source, sentinel;
    const pl_u64 address = 0x30000000u, bytes = 8193u;
    memset(page,0xa5,sizeof page); memset(&source,0x5a,sizeof source); sentinel=source;
    EXPECT(vm_boot_page(&boot,address,page,&source)==-1);
    EXPECT(!memcmp(&source,&sentinel,sizeof source));
    EXPECT(!vm_boot_attach_image(&boot,address,bytes));
    for (pl_u32 i=0u;i<3u;++i) {
        EXPECT(vm_boot_page(&boot,address+i*4096ull,page,&source)==VM_BOOT_IMAGE);
        EXPECT(source.kind==VM_BOOT_IMAGE && source.offset==i*4096ull);
        EXPECT(source.bytes==(i==2u?1u:4096u));
        for (pl_u32 at=0u;at<4096u;++at) EXPECT(page[at]==0xa5u);
    }
    EXPECT(vm_boot_page(&boot,address-4096u,page,&source)==-1);
    EXPECT(vm_boot_page(&boot,address+12288u,page,&source)==-1);
    EXPECT(vm_boot_page(&boot,boot.ram_bytes,page,&source)==-1);
    EXPECT(vm_boot_page(&boot,0x1000u,page,&source)==VM_BOOT_METADATA);
    EXPECT(page[0x1e8u]==4u);
    EXPECT(vm_memory_load(page+0x30cu,8u)==address);
    EXPECT(vm_memory_load(page+0x314u,8u)==12288u);
    EXPECT(vm_memory_load(page+0x31cu,4u)==2u);
    EXPECT(vm_memory_load(page+0x300u,8u)==boot.ram_bytes-0x100000u);

    /* Independently classify arbitrary extent pairs, including u64 overflow.
     * Rejected reattachment cannot retain a previously accepted image. */
    pl_u64 seed=0xf79253a984be1234ull;
    for (pl_u32 i=0u;i<100000u;++i) {
        seed^=seed<<13u; seed^=seed>>7u; seed^=seed<<17u;
        pl_u64 at=i&1u?seed&~4095ull:seed&0x3ffff000u;
        pl_u64 length=i&2u?seed>>32u:(seed>>20u)&0xfffffff;
        if (!(i%7u)) ++at;
        if (!(i%11u)) length=0u;
        int valid=(at%4096u==0u && at>=0x8000000u && at<0x40000000u
            && length>0u && length<=0x10000000u && length<=0x40000000u-at);
        EXPECT(vm_boot_attach_image(&boot,at,length)==(valid?0:-1));
        if (valid) {
            EXPECT(vm_boot_page(&boot,at,page,&source)==VM_BOOT_IMAGE);
            EXPECT(source.offset==0u && source.bytes==(length<4096u?length:4096u));
            pl_u64 last=(length-1u)&~4095ull;
            EXPECT(vm_boot_page(&boot,at+last,page,&source)==VM_BOOT_IMAGE);
            EXPECT(source.offset==last && source.bytes==length-last);
            EXPECT(vm_boot_page(&boot,at+last+4096u,page,&source)==-1);
        } else EXPECT(!boot.image_address && !boot.image_bytes && boot.header==header);
    }
    EXPECT(!vm_boot_attach_image(&boot,0x3ffff000u,4096u));
    EXPECT(vm_boot_attach_image(&boot,0x3ffff000u,4097u)==-1);
    EXPECT(vm_boot_attach_image(NULL,address,bytes)==-1);
    vm_boot empty={0}; EXPECT(vm_boot_attach_image(&empty,address,bytes)==-1);

    /* The existing page ticket owns retry/context/generation and private RAM.
     * Transport writes authenticated source bytes and final padding only. */
    EXPECT(!vm_boot_attach_image(&boot,address,bytes));
    vm_memory memory; vm_page_supply supply={0}; machine_state state={.rip=0x1000200u};
    vm_page_request request, same;
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,0u,4u,branches,9u));
    pending(&supply,&memory,&state,address+8192u);
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request));
    EXPECT(request.source_kind==VM_BOOT_IMAGE && request.source_offset==8192u && request.source_bytes==1u);
    EXPECT(request.target_offset==4096u && memory.page_count==0u);
    memset(arena+request.target_offset,0,4096u); arena[request.target_offset]=0x6du;
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,0u,&same));
    EXPECT(!memcmp(&request,&same,sizeof request) && arena[4096u]==0x6du);
    ++state.rip; EXPECT(vm_supply_commit(&supply,&memory,&state,0u,request.ticket)==-1); --state.rip;
    EXPECT(vm_supply_commit(&supply,&memory,&state,0u,request.ticket+1u)==-1);
    EXPECT(!vm_supply_commit(&supply,&memory,&state,0u,request.ticket));
    EXPECT(pages[0].kind==VM_MEMORY_RAM && memory.page_count==1u);
    EXPECT(vm_supply_commit(&supply,&memory,&state,0u,request.ticket)==-1);
    memory.write_touched=0u;
    EXPECT(!vm_memory_access(&memory,0u,address+8192u,8u,2u,~0ull));
    EXPECT(memory.write_touched);
    for (pl_u32 i=4096u;i<4104u;++i) EXPECT(arena[i]==0xffu);
    for (pl_u32 i=4104u;i<8192u;++i) EXPECT(!arena[i]);
    pending(&supply,&memory,&state,address+8192u);
    EXPECT(vm_supply_prepare(&supply,&memory,&boot,&state,0u,&request)==-1);
    if (!failures) puts("boot image: green (100000 independent extent pairs, E820, bounded immutable source, retry/stale/private RAM writes); NOT Linux boot");
    return failures?1:0;
}

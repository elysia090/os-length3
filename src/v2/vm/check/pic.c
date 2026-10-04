#include <vm/pic.h>
#include <stdio.h>
#include <string.h>
static unsigned failures, grants;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"pic: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static vm_pic pic;
static void write_port(pl_u32 port, pl_u32 byte)
{ EXPECT(!vm_pic_transfer(&pic,port,1u,&byte)); }
static pl_u32 read_port(pl_u32 port)
{ pl_u32 byte=0u; EXPECT(!vm_pic_transfer(&pic,port,0u,&byte)); return byte; }
static void initialize(pl_u32 mode)
{
    vm_pic_reset(&pic);
    write_port(0x20u,0x11u); write_port(0xa0u,0x11u);
    write_port(0x21u,0x20u); write_port(0xa1u,0x28u);
    write_port(0x21u,4u); write_port(0xa1u,2u);
    write_port(0x21u,mode); write_port(0xa1u,mode);
}
/* Standalone C device oracle driver; no guest CPU or product protocol. */
static int trace(void)
{
    char command; unsigned port, value; vm_pic_reset(&pic);
    while (scanf(" %c",&command)==1) {
        if (command=='W' || command=='L') {
            if (scanf(" %u %u",&port,&value)!=2) return 2;
            if (command=='W') {
                if (vm_pic_transfer(&pic,port,1u,&value)) return 2;
            } else if (vm_pic_set_irq(&pic,port,value)) return 2;
        } else if (command=='R') {
            if (scanf(" %u",&port)!=1) return 2;
            value=0u; if (vm_pic_transfer(&pic,port,0u,&value)) return 2;
            printf("%u\n",value);
        } else return 2;
    }
    return 0;
}
int main(int argc, char **argv)
{
    if (argc==2 && !strcmp(argv[1],"--trace")) return trace();
    initialize(1u); write_port(0xa1u,255u); EXPECT(read_port(0xa1u)==255u);
    for (pl_u32 rotation=0u;rotation<8u;++rotation)
    for (pl_u32 mask=0u;mask<256u;++mask)
    for (pl_u32 request=0u;request<8u;++request)
    for (pl_u32 service=0u;service<=8u;++service) {
        vm_pic_chip *c=&pic.chip[0]; *c=(vm_pic_chip){0};
        c->priority=(pl_u8)rotation; c->mask=(pl_u8)mask;
        c->request=(pl_u8)(1u<<((request+rotation)&7u));
        c->service=(pl_u8)(service==8u ? 0u : 1u<<((service+rotation)&7u));
        EXPECT(vm_pic_pending(&pic)==(request<service && !(mask & c->request)));
        ++grants;
    }
    initialize(1u); EXPECT(!vm_pic_set_irq(&pic,5u,1u));
    EXPECT(vm_pic_pending(&pic) && vm_pic_acknowledge(&pic)==0x25);
    EXPECT(pic.chip[0].service==32u && !pic.chip[0].request);
    EXPECT(!vm_pic_set_irq(&pic,5u,1u) && !vm_pic_pending(&pic)); /* no new edge */
    write_port(0x20u,0x65u); /* specific EOI */
    EXPECT(!vm_pic_set_irq(&pic,5u,0u) && !vm_pic_set_irq(&pic,5u,1u));
    write_port(0x20u,0x0au); EXPECT(read_port(0x20u)==32u);
    write_port(0x20u,0x0cu); EXPECT(read_port(0x20u)==0x85u);
    write_port(0x20u,0x0bu); EXPECT(read_port(0x20u)==32u);
    EXPECT(read_port(0x20u)==32u); write_port(0x20u,0xa0u);
    EXPECT(!pic.chip[0].service && pic.chip[0].priority==6u);
    initialize(1u); write_port(0x4d0u,255u); write_port(0x4d1u,255u);
    EXPECT(read_port(0x4d0u)==0xf8u && read_port(0x4d1u)==0xdeu);
    EXPECT(!vm_pic_set_irq(&pic,5u,1u) && vm_pic_acknowledge(&pic)==0x25);
    EXPECT(pic.chip[0].request==32u && !vm_pic_pending(&pic));
    write_port(0x20u,0x20u); EXPECT(vm_pic_pending(&pic));
    EXPECT(!vm_pic_set_irq(&pic,5u,0u) && !vm_pic_pending(&pic));
    initialize(1u); EXPECT(!vm_pic_set_irq(&pic,10u,1u));
    EXPECT(vm_pic_pending(&pic) && vm_pic_acknowledge(&pic)==0x2a);
    EXPECT(pic.chip[0].service==4u && pic.chip[1].service==4u);
    write_port(0xa0u,0x20u); write_port(0x20u,0x20u); EXPECT(!vm_pic_pending(&pic));
    initialize(1u); EXPECT(!vm_pic_set_irq(&pic,10u,1u));
    write_port(0x20u,0x11u); EXPECT(!pic.chip[0].request);
    write_port(0xa0u,0x11u); EXPECT(!pic.chip[0].request);
    /* Reinitializing the master alone must not fabricate a slave edge. */
    initialize(1u);
    EXPECT(vm_pic_acknowledge(&pic)==0x27 && !pic.chip[0].service);
    /* A disappearing level slave leaves an edge request on the master. */
    initialize(1u); write_port(0x4d1u,4u);
    EXPECT(!vm_pic_set_irq(&pic,10u,1u) && !vm_pic_set_irq(&pic,10u,0u));
    EXPECT(vm_pic_acknowledge(&pic)==0x2f && pic.chip[0].service==4u && !pic.chip[1].service);
    initialize(3u); write_port(0x20u,0x80u);
    EXPECT(!vm_pic_set_irq(&pic,4u,1u) && vm_pic_acknowledge(&pic)==0x24);
    EXPECT(!pic.chip[0].service && pic.chip[0].priority==5u);
    initialize(1u); EXPECT(!vm_pic_set_irq(&pic,4u,1u) && vm_pic_acknowledge(&pic)==0x24);
    write_port(0x21u,16u); EXPECT(!vm_pic_set_irq(&pic,5u,1u) && !vm_pic_pending(&pic));
    write_port(0x20u,0x68u); EXPECT(vm_pic_pending(&pic)); /* special mask */
    write_port(0x20u,0x48u); EXPECT(!vm_pic_pending(&pic));
    initialize(0x11u); EXPECT(!vm_pic_set_irq(&pic,10u,1u) && vm_pic_acknowledge(&pic)==0x2a);
    EXPECT(!vm_pic_set_irq(&pic,9u,1u) && vm_pic_pending(&pic)); /* fully nested */
    initialize(1u); write_port(0x4d0u,0x80u); write_port(0x20u,0x19u);
    write_port(0x21u,0x20u); write_port(0x21u,4u); write_port(0x21u,1u);
    EXPECT(read_port(0x4d0u)==0x80u && pic.chip[0].level_triggered);
    EXPECT(!vm_pic_set_irq(&pic,0u,1u) && vm_pic_acknowledge(&pic)==0x20);
    EXPECT(pic.chip[0].request==1u); write_port(0x20u,0x20u); EXPECT(vm_pic_pending(&pic));
    /* Invalid inputs and unsupported CPU mode cannot partially change state. */
    vm_pic before=pic; pl_u32 bad=0x10u;
    EXPECT(vm_pic_transfer(&pic,0x20u,1u,&bad)==-1 && !memcmp(&before,&pic,sizeof pic));
    EXPECT(vm_pic_transfer(&pic,0x80u,1u,&bad)==-1 && !memcmp(&before,&pic,sizeof pic));
    EXPECT(vm_pic_set_irq(&pic,2u,1u)==-1 && vm_pic_set_irq(&pic,16u,1u)==-1);
    write_port(0x20u,0x13u); write_port(0x21u,0x20u);
    before=pic; bad=0u;
    EXPECT(vm_pic_transfer(&pic,0x21u,1u,&bad)==-1 && !memcmp(&before,&pic,sizeof pic));
    write_port(0x21u,1u); EXPECT(pic.chip[0].phase==0u && pic.chip[0].single);
    if (!failures) printf("C PIC: %u priority/mask grants, ICW/OCW/poll/EOI/cascade/level/refusal checks pass; no CPU interrupt delivery claim\n",grants);
    return failures ? 1 : 0;
}

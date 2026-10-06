#include <vm/pic.h>

static pl_u32 first(const vm_pic_chip *c, pl_u32 bits)
{
    for (pl_u32 rank=0u;rank<8u;++rank)
        if (bits & (1u << ((rank+c->priority)&7u))) return rank;
    return 8u;
}
static int grant(const vm_pic_chip *c, pl_u32 master,pl_u32 requests)
{
    pl_u32 rank=first(c,requests & ~(pl_u32)c->mask);
    pl_u32 service=c->service;
    if (c->special_mask) service &= ~(pl_u32)c->mask;
    if (master && c->fully_nested) service &= ~4u;
    return rank < first(c,service) ? (int)((rank+c->priority)&7u) : -1;
}
static int pending(const vm_pic_chip *c,pl_u32 master)
{ return grant(c,master,c->request); }
static void line(vm_pic_chip *c, pl_u32 irq, pl_u32 high)
{
    pl_u32 bit=1u<<irq;
    if (c->level_triggered || (c->elcr & bit)) {
        if (high) c->request |= (pl_u8)bit;
        else c->request &= (pl_u8)~bit;
    } else if (high && !(c->lines & bit)) c->request |= (pl_u8)bit;
    if (high) c->lines |= (pl_u8)bit;
    else c->lines &= (pl_u8)~bit;
}
static void cascade(vm_pic *pic)
{ line(&pic->chip[0],2u,(pl_u32)(pending(&pic->chip[1],0u)>=0)); }
static void acknowledge(vm_pic_chip *c, pl_u32 irq)
{
    pl_u32 bit=1u<<irq;
    if (c->auto_eoi) { if (c->rotate_auto) c->priority=(pl_u8)((irq+1u)&7u); }
    else c->service |= (pl_u8)bit;
    if (!c->level_triggered && !(c->elcr & bit)) c->request &= (pl_u8)~bit;
}
static int rank(pl_u32 port)
{
    if (port==0x20u || port==0x21u || port==0x4d0u) return 0;
    if (port==0xa0u || port==0xa1u || port==0x4d1u) return 1;
    return -1;
}
void vm_pic_reset(vm_pic *pic)
{ if (pic) *pic=(vm_pic){0}; }
int vm_pic_accepts(const vm_pic *pic, pl_u32 port, pl_u32 write, pl_u32 value)
{
    int index=rank(port);
    if (!pic || index<0 || write>1u || value>255u) return 0;
    if (!write || port>=0x4d0u) return 1;
    const vm_pic_chip *c=&pic->chip[index];
    if (!(port&1u) && (value&16u))
        return (value&1u)!=0u; /* ICW4 required for the supported CPU mode. */
    if ((port&1u) && c->phase==3u) return (value&1u)!=0u;
    return 1;
}
int vm_pic_transfer(vm_pic *pic, pl_u32 port, pl_u32 write, pl_u32 *value)
{
    if (!value || !vm_pic_accepts(pic,port,write,*value)) return -1;
    int selected=rank(port);
    if (selected<0) return -1;
    pl_u32 index=(pl_u32)selected, byte=*value;
    vm_pic_chip *c=&pic->chip[index];
    pl_u32 update=port<0x4d0u && (write || c->poll);
    if (port>=0x4d0u) {
        pl_u32 mask=index ? 0xdeu : 0xf8u;
        /* ELCR is independent of ICW1's global level mode. */
        if (write) c->elcr=(pl_u8)(byte&mask);
        else *value=c->elcr;
    } else if (!write) {
        if (c->poll) {
            int irq=pending(c,index==0u);
            c->poll=0u; *value=irq<0 ? 0u : 0x80u|(pl_u32)irq;
            if (irq>=0) acknowledge(c,(pl_u32)irq);
        } else *value=(port&1u) ? c->mask : c->read_service ? c->service : c->request;
    } else if (!(port&1u)) {
        if (byte&16u) {
            pl_u8 elcr=c->elcr;
            *c=(vm_pic_chip){0}; c->elcr=elcr; c->phase=1u;
            c->single=(pl_u8)((byte>>1u)&1u);
            c->level_triggered=(pl_u8)((byte>>3u)&1u);
        } else if (byte&8u) {
            if (byte&4u) c->poll=1u;
            if (byte&2u) c->read_service=(pl_u8)(byte&1u);
            if (byte&64u) c->special_mask=(pl_u8)((byte>>5u)&1u);
        } else {
            pl_u32 command=byte>>5u, irq=byte&7u;
            if (command==0u || command==4u) c->rotate_auto=(pl_u8)(command>>2u);
            else if (command==6u) c->priority=(pl_u8)((irq+1u)&7u);
            else if (command==1u || command==5u) {
                pl_u32 order=first(c,c->service);
                if (order!=8u) {
                    irq=(order+c->priority)&7u; c->service &= (pl_u8)~(1u<<irq);
                    if (command==5u) c->priority=(pl_u8)((irq+1u)&7u);
                }
            } else if (command==3u || command==7u) {
                c->service &= (pl_u8)~(1u<<irq);
                if (command==7u) c->priority=(pl_u8)((irq+1u)&7u);
            }
        }
    } else if (c->phase==1u) {
        c->base=(pl_u8)(byte&248u); c->phase=c->single ? 3u : 2u;
    } else if (c->phase==2u) { c->cascade=(pl_u8)byte; c->phase=3u; }
    else if (c->phase==3u) {
        c->auto_eoi=(pl_u8)((byte>>1u)&1u);
        c->fully_nested=(pl_u8)((byte>>4u)&1u); c->phase=0u;
    } else c->mask=(pl_u8)byte;
    /* A master access must not re-drive an unchanged slave wire after ICW1
     * reset: that would invent a rising edge in the cleared master IRR. */
    if (index && update) cascade(pic);
    return 0;
}
int vm_pic_set_irq(vm_pic *pic, pl_u32 irq, pl_u32 high)
{
    if (!pic || irq>=16u || irq==2u || high>1u) return -1;
    line(&pic->chip[irq>>3u],irq&7u,high);
    if (irq>=8u) cascade(pic);
    return 0;
}
int vm_pic_pending(const vm_pic *pic)
{ return pic && pending(&pic->chip[0],1u)>=0; }
int vm_pic_can_irq(const vm_pic *pic,pl_u32 irq)
{
    if(!pic || irq>=16u || irq==2u)return 0;
    for(pl_u32 chip=irq>=8u?1u:0u;;chip=0u){
        const vm_pic_chip *c=&pic->chip[chip];
        pl_u32 bit=1u<<(chip?irq&7u:irq>=8u?2u:irq);
        if(grant(c,!chip,bit)<0)return 0;
        if(!chip)return 1;
        if(pic->chip[0].single || !(pic->chip[0].cascade&4u) || (c->cascade&7u)!=2u)return 0;
    }
}
int vm_pic_acknowledge(vm_pic *pic)
{
    if (!pic) return -1;
    int irq=pending(&pic->chip[0],1u), vector;
    if (irq<0) return pic->chip[0].base+7;
    if (irq==2 && !pic->chip[0].single) {
        /* The supported board has only this cascade. Reject incompatible
         * programmed wiring instead of selecting a different slave. */
        if (!(pic->chip[0].cascade&4u) || (pic->chip[1].cascade&7u)!=2u) return -1;
        int slave=pending(&pic->chip[1],0u);
        vector=pic->chip[1].base+(slave<0 ? 7 : slave);
        if (slave>=0) acknowledge(&pic->chip[1],(pl_u32)slave);
        cascade(pic);
    } else vector=pic->chip[0].base+irq;
    acknowledge(&pic->chip[0],(pl_u32)irq); return vector;
}

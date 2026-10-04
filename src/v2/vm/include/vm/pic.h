#ifndef VM_PIC_H
#define VM_PIC_H
#include <support/types.h>
typedef struct {
    pl_u8 request, service, mask, lines, elcr, base, priority;
    pl_u8 phase, single, cascade, read_service, poll, special_mask;
    pl_u8 auto_eoi, rotate_auto, fully_nested, level_triggered;
} vm_pic_chip;
typedef struct { vm_pic_chip chip[2]; } vm_pic;
/* PC pair: slave output is wired to master IR2. Byte ports 20/21,A0/A1
 * and ELCR 4D0/4D1; 8086 ICWs, OCWs, edge/level, poll and EOI.
 * 8080 mode is explicitly unsupported. No host time or CPU injection here. */
void vm_pic_reset(vm_pic *pic);
int vm_pic_accepts(const vm_pic *pic, pl_u32 port, pl_u32 write, pl_u32 value);
int vm_pic_transfer(vm_pic *pic, pl_u32 port, pl_u32 write, pl_u32 *value);
/* IRQ2 belongs to the cascade, not an external source. Acknowledge returns
 * the vector (including spurious IRQ7/15); caller owns CPU interrupt delivery. */
int vm_pic_set_irq(vm_pic *pic, pl_u32 irq, pl_u32 level);
int vm_pic_pending(const vm_pic *pic);
int vm_pic_acknowledge(vm_pic *pic);
#endif

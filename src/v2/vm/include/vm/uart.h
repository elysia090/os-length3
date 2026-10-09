#ifndef VM_UART_H
#define VM_UART_H
#include <support/types.h>
/* One serialized 16550A-compatible COM1, sampled virtual device time.
 * No allocator, host pointer, guest opcode or Linux console semantics. */
typedef struct {
    pl_u64 deadline;
    pl_u16 divisor;
    pl_u8 rx[16], head, count, rbr, ier, lcr, mcr, fcr, errors, scratch;
    pl_u8 thre_pending, timeout;
} vm_uart;
_Static_assert(sizeof(vm_uart)==40u,"bounded UART state extent");
void vm_uart_reset(vm_uart *uart);
int vm_uart_accepts(pl_u32 coordinate);
/* 0: synchronous register/loopback transfer, 1: external byte transmission
 * required without device mutation, -1: invalid transfer. The caller must
 * own/acknowledge that external operation before calling transmit_commit. */
int vm_uart_transfer(vm_uart *uart, pl_u64 now, pl_u32 coordinate,
    pl_u32 write, pl_u32 *value);
int vm_uart_transmit_commit(vm_uart *uart, pl_u32 value);
void vm_uart_advance(vm_uart *uart, pl_u64 now);
int vm_uart_irq(const vm_uart *uart);
int vm_uart_next_irq(const vm_uart *uart, pl_u64 *nanoseconds);
/* Serialized external byte, with backpressure rather than fabricated
 * overrun. 1 accepts once, 0 waits for FIFO space, -1 refuses unchanged. */
int vm_uart_receive(vm_uart *uart,pl_u64 now,pl_u32 byte);
#endif

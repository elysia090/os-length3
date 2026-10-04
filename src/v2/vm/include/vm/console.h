#ifndef VM_CONSOLE_H
#define VM_CONSOLE_H
#include <vm/memory.h>
#include <machine/state.h>
#include <machine/io.h>
/* Serialized byte frontier, not an output queue or guest terminal model.
 * stage: idle=0, requested=1, accepted=2, consumed=3. Keep the last tuple
 * for duplicate acknowledgements; a new request replaces it in O(1). */
typedef struct {
    pl_u64 issued, ticket, generation, rip;
    pl_u32 port, byte, stage;
} vm_console;
_Static_assert(sizeof(vm_console)==48u,"bounded console frontier extent");
void vm_console_abort(vm_console *console);
void vm_console_close(vm_console *console);
int vm_console_pending(const vm_console *console);
machine_result vm_console_write(vm_console *console, vm_memory *physical,
    pl_u32 port, const machine_state *state, pl_u32 byte);
/* Supervisor transport admission: 1 = first acceptance, 0 = exact duplicate,
 * -1 = rejected without mutation. Publish the byte only on 1, never on 0.
 * The actual sink must reserve capacity before accepting. A fresh Worker
 * requires a fresh broker generation and an external replay/dedup policy. */
int vm_console_reply(vm_console *console, pl_u64 generation, pl_u32 port,
    const machine_state *state, pl_u64 ticket, pl_u32 byte);
int vm_console_consume(vm_console *console);
#endif

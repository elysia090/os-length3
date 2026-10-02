/* Uniform compiled function type for bounded execution tables. */
#ifndef MACHINE_ENTRY_H
#define MACHINE_ENTRY_H
#include <machine/result.h>
#define MACHINE_ENTRY_ABI_VERSION 1u
typedef machine_result (*machine_entry)(pl_u32 state, pl_u32 port);
#endif

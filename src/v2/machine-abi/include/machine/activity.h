/* Logical-processor activity is independent of compiled code residency. */
#ifndef MACHINE_ACTIVITY_H
#define MACHINE_ACTIVITY_H
#include <support/types.h>

enum { MACHINE_ACTIVITY_RUNNING, MACHINE_ACTIVITY_HALTED };
typedef struct { pl_u32 state; } machine_activity;

/* Exact suspend must retain this word as well as registers and devices.
 * Rebinding or evicting compiled code cannot wake a halted processor.
 * An accepted interrupt or machine reset, not a source fetch, resumes it. */
#endif

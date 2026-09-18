/* Events are the complete observable boundary of one deterministic step. */

#ifndef MACHINE_EVENT_H
#define MACHINE_EVENT_H

#include <support/types.h>

enum machine_event_kind {
    MACHINE_EVENT_NONE = 0,
    MACHINE_EVENT_BLOCK_READ,
    MACHINE_EVENT_BLOCK_WRITE,
    MACHINE_EVENT_CONSOLE_READ,
    MACHINE_EVENT_CONSOLE_WRITE,
    MACHINE_EVENT_CLOCK,
    MACHINE_EVENT_ENTROPY,
    MACHINE_EVENT_NETWORK_POLL,
    MACHINE_EVENT_INTERRUPT,
};

typedef struct {
    pl_u32 kind;
    pl_u32 flags;
    pl_u64 coordinate;
    pl_u64 value;
    pl_u64 generation;
} machine_event;

#endif /* MACHINE_EVENT_H */

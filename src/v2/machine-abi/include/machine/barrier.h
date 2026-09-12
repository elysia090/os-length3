/* Replayable cut between pure machine slices and external operations. */

#ifndef MACHINE_BARRIER_H
#define MACHINE_BARRIER_H

#include <machine/event.h>

typedef struct {
    machine_event event;
    pl_u64 continuation;
    pl_u64 generation;
    pl_u64 reservation;
} machine_barrier;

#endif /* MACHINE_BARRIER_H */

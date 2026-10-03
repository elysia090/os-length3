/* Scalar port transfers and the explicit monotonic clock event. */
#ifndef MACHINE_IO_H
#define MACHINE_IO_H
#include <machine/memory.h>
#define MACHINE_IO_WRITE 0x100u
#define MACHINE_CLOCK_REQUEST 0x100u
/* machine.io(i32 private_port, i32 io_port, i32 bytes|WRITE, i64 value)
 * and machine.time(i32 private_port) return the common result token.
 * A clock wait publishes a ticket in request_address, bytes=0 and access=
 * CLOCK_REQUEST. Only the supervisor may supply the sampled nanoseconds.
 * No CPU output, device transfer or retirement occurs before that reply. */
#endif

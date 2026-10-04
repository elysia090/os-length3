/* Scalar port transfers and the explicit monotonic clock event. */
#ifndef MACHINE_IO_H
#define MACHINE_IO_H
#include <machine/memory.h>
#define MACHINE_IO_WRITE 0x100u
#define MACHINE_CLOCK_REQUEST 0x100u
#define MACHINE_CONSOLE_WRITE_REQUEST 0x200u
/* machine.io(i32 private_port, i32 io_port, i32 bytes|WRITE, i64 value)
 * and machine.time(i32 private_port) return the common result token.
 * A clock wait publishes a ticket in request_address, bytes=0 and access=
 * CLOCK_REQUEST. Only the supervisor may supply the sampled nanoseconds.
 * No CPU output, device transfer or retirement occurs before that reply. */
/* Console write barrier: request_address is a non-reused ticket, bytes=1,
 * access=CONSOLE_WRITE_REQUEST, value is the exact byte. Only a supervisor
 * sink may acknowledge it. Generated code receives no console/lifecycle
 * imports; successful UART commit and retirement follow its pinned retry. */
#endif

# Initial non-TTY stream fixture

Static x86-64 program using only read, write and exit. It checks wrong-direction
FD rejection, input range rejection before consumption, zero-length access, binary
stdin/stdout transfer, independent stderr, EOF and exit status. It intentionally
uses tiny finite input; it is not a short-write, blocking cancellation, TTY or full
libc compatibility test. The parent test runs this as translated code, never as a
native executable.

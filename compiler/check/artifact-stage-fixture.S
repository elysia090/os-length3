/* A release-stage success witness must itself close through normalized x86.
 * Large non-allocated input makes the ordinary optimized ELF strictly
 * smaller without adding executable spelling that could hide an emitter gap.
 */
    .text
    .globl _start
    .type _start, @function
_start:
    call stage_body
    ret
    .size _start, .-_start

    .section .comment
    .zero 32768

    .section .note.GNU-stack,"",@progbits

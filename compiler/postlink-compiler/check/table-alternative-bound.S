/* Both paths reach one relative jump table. The nearby narrow comparison
 * does not bound the fallthrough path. Its row comes from an earlier constant,
 * including rows beyond one byte and consumers in long functions. */
#ifdef WIDE_TABLE
.set selected_row, 300
.set maximum_row, 331
#else
.set selected_row, 50
.set maximum_row, 81
#endif
.section .text
.globl _start
.type _start, @function
_start:
#ifdef LARGE_FUNCTION
    .rept 1200
    nop
    .endr
#endif
    leaq table(%rip), %r12
    movl $selected_row, %edx
#ifndef NO_OUTER_GUARD
    cmpl $maximum_row, %edx
    ja .Lbad
#endif
    cmpl $8, %edx
    jbe .Ldispatch
#ifdef SPLIT_EDGE
    nop
#endif
.Ldispatch:
    movslq (%r12,%rdx,4), %rdx
    addq %r12, %rdx
    jmp *%rdx
.Lcase50:
    movl $42, %edi
    movl $60, %eax
    syscall
.Lbad:
    movl $1, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.section .rodata
.p2align 2
table:
    .rept selected_row
    .long .Lbad - table
    .endr
    .long .Lcase50 - table
    .rept maximum_row - selected_row
    .long .Lbad - table
    .endr

.section .note.GNU-stack,"",@progbits

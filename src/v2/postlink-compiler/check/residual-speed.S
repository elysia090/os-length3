.section .text
.global _start
.type _start,@function
#ifndef RESIDUAL_SPEED_ITERATIONS
#define RESIDUAL_SPEED_ITERATIONS 10000000
#endif
_start:
    mov $RESIDUAL_SPEED_ITERATIONS, %ecx
    xor %r8d, %r8d
.Lhot:
    mov $1, %eax
    .rept 8
    imul $3, %rax, %rax
    .endr
    mov $7, %eax
    add %rax, %r8
    dec %ecx
    jne .Lhot
    call residual_barrier
    xor %edi, %edi
    mov $60, %eax
    syscall
.size _start, .-_start

.section .text.residual_barrier,"ax",@progbits
.global residual_barrier
.type residual_barrier,@function
residual_barrier:
    ret
.size residual_barrier, .-residual_barrier

/* Keep one ordinary construction relocation in the linked input.  It is not
 * executed and is absent from the optimized runtime section table. */
.section .rodata
.quad .Lhot

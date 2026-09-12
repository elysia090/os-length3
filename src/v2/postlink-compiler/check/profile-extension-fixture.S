.section .text,"ax",@progbits

.global _start
.type _start,@function
_start:
    lea .Lkey(%rip), %rdi
    lea .Lschedule(%rip), %rdx
    mov $256, %esi
    call set_key
    test %eax, %eax
    jne .Lfailed
    mov $60, %eax
    mov $42, %edi
    syscall
.Lfailed:
    mov $60, %eax
    mov $1, %edi
    syscall
.size _start, .-_start

/* A linked x86 product may contain an extension path selected by native
 * CPUID even when a later delivery projection exposes a narrower profile.
 * The post-link x86 compiler must preserve that path and its fallthrough; it
 * may not turn the instruction into an analysis-only #UD class while copying
 * executable source bytes into the ordinary output ELF. */
.type set_key,@function
set_key:
    sub $8, %rsp
    mov $-1, %rax
    test %rdi, %rdi
    je .Ldone
    cmp $256, %esi
    je .Lvalid256
    mov $-2, %rax
    jmp .Ldone
.Lvalid256:
    movups (%rdi), %xmm2
    movdqa .Lshuffle(%rip), %xmm5
    pshufb %xmm5, %xmm2
    aesenclast %xmm2, %xmm5
    aeskeygenassist $1, %xmm5, %xmm4
    movups %xmm4, (%rdx)
    xor %eax, %eax
.Ldone:
    add $8, %rsp
    ret
.size set_key, .-set_key

.section .rodata,"a",@progbits
.balign 16
.Lkey:
    .byte 0, 1, 2, 3, 4, 5, 6, 7
    .byte 8, 9, 10, 11, 12, 13, 14, 15
.Lshuffle:
    .byte 15, 14, 13, 12, 11, 10, 9, 8
    .byte 7, 6, 5, 4, 3, 2, 1, 0

.section .bss,"aw",@nobits
.balign 16
.Lschedule:
    .zero 16

.section .text.unreachable,"ax",@progbits
.fill 4096, 1, 0xcc

.section .note.GNU-stack,"",@progbits

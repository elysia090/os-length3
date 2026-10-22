/* Substitute rcx = rax + 12: [rdi + 4*rcx] equals
 * [rdi + 4*rax + 48]. A changed generation or bypassed definition does not. */
.text
.globl _start
.type _start,@function
_start:
    lea .Lstate(%rip), %rdi
    lea .Lrows(%rip), %r9
    xor %eax, %eax
#ifdef BYPASS_DEFINITION
    mov $13, %ecx
    jmp .Lcompare
#endif
    lea 12(%rax), %rcx
.Lcompare:
    cmpl $4, 48(%rdi,%rax,4)
    ja .Lbad
#ifdef MUTATE_INDEX
    inc %rax
#endif
#ifdef MUTATE_COPY
    inc %rcx
#endif
#ifdef MUTATE_MEMORY
    movl $7, 48(%rdi,%rax,4)
#endif
    mov (%rdi,%rcx,4), %ecx
    movslq (%r9,%rcx,4), %rcx
    add %r9, %rcx
    jmp *%rcx
.Lbad:
    mov $1, %edi
    jmp .Lexit
.Lgood:
    mov $42, %edi
.Lexit:
    .rept 16
    nop
    .endr
    mov $60, %eax
    syscall
.size _start, .-_start
.section .rodata
.balign 4
.Lrows:
    .long .Lbad-.Lrows
    .long .Lbad-.Lrows
    .long .Lgood-.Lrows
    .long .Lbad-.Lrows
    .long .Lbad-.Lrows
    .long .Lbad-.Lrows
    .long .Lbad-.Lrows
    .long .Lgood-.Lrows
.section .data
.balign 8
.Lstate:
    .zero 48
    .long 2
    .long 7
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
    .zero 8192

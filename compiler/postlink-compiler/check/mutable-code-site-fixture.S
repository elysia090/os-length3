.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr

    /* Resolve two code coordinates exclusively through allocated data.  The
     * linked futures are equal, but their addresses are independently
     * observable and one of the instruction fields is modified at runtime. */
    lea patch_sites(%rip), %rbx
    movslq 0(%rbx), %r12
    add %rbx, %r12
    movslq 4(%rbx), %r13
    lea 4(%rbx,%r13), %r13
    cmp %r12, %r13
    je failed

    mov %r12, %rdi
    and $-4096, %rdi
    mov $4096, %esi
    mov $7, %edx
    mov $10, %eax
    syscall
    test %rax, %rax
    jne failed

    lea target_b(%rip), %rax
    sub %r12, %rax
    sub $5, %eax
    movb $0xe9, 0(%r12)
    mov %eax, 1(%r12)

    call *%r12
    cmp $42, %eax
    jne failed
    call *%r13
    cmp $7, %eax
    jne failed

    mov $60, %eax
    mov $42, %edi
    syscall
failed:
    mov $60, %eax
    mov $1, %edi
    syscall
    ud2
.size _start, .-_start

site_a:
    .byte 0xe9
    .long target_a - . - 4
site_b:
    .byte 0xe9
    .long target_a - . - 4
target_a:
    mov $7, %eax
    ret
target_b:
    mov $42, %eax
    ret

.pushsection .patch_sites,"a",@progbits
patch_sites:
    .long site_a - .
    .long site_b - .
.popsection

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits

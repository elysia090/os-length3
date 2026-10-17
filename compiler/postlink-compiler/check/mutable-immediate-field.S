.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    /* Row-relative data points inside an instruction, not at an entry.
     * Patching these fields must neither retarget another instruction nor
     * let a constant fold retain their pre-initialization values. */
    lea fields(%rip), %rbx
    movslq (%rbx), %r12
    add %rbx, %r12
    movslq 4(%rbx), %r13
    lea 4(%rbx,%r13), %r13
    movslq 8(%rbx), %r14
    lea 8(%rbx,%r14), %r14
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
    movq $42, (%r12)
    movq $43, (%r13)
    movb $3, (%r14)
    call first
    cmp $42, %rax
    jne failed
    call second
    cmp $43, %rax
    jne failed
    call shifted
    cmp $42, %eax
    jne failed
    mov $42, %edi
    jmp finished
failed:
    mov $1, %edi
finished:
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start

.type first, @function
first:
    .byte 0x48, 0xb8
.Lfirst_field:
    .quad 0x0123456789abcdef
    ret
.size first, .-first
.type second, @function
second:
    .byte 0x48, 0xb8
.Lsecond_field:
    .quad 0x0123456789abcdef
    ret
.size second, .-second
.type shifted, @function
shifted:
    mov $336, %eax
    .byte 0xc1, 0xe8
.Lshift_field:
    .byte 12
    ret
.size shifted, .-shifted

.section .patch_fields,"a",@progbits
fields:
    .long .Lfirst_field-.
    .long .Lsecond_field-.
    .long .Lshift_field-.
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

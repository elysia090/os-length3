.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea callbacks(%rip), %rbx
    lea callbacks_end(%rip), %rbp
next:
    cmp %rbp, %rbx
    jae passed
    /* Each signed offset is relative to its own row, not the table base.
     * Advancing the iterator before CALL must not lose the target entry. */
    movslq (%rbx), %rax
    add %rbx, %rax
    add $4, %rbx
    call *%rax
    cmp $42, %eax
    jne failed
    jmp next
passed:
    mov $42, %edi
    jmp finished
failed:
    mov $1, %edi
finished:
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start
.fill 1024, 1, 0xcc
.type first, @function
first:
.Lfirst:
    mov $42, %eax
    ret
.size first, .-first
.type second, @function
second:
.Lsecond:
    xor %eax, %eax
    add $42, %eax
    ret
.size second, .-second
.section .callbacks,"a",@progbits
callbacks:
    .long .Lfirst-.
    .long .Lsecond-.
callbacks_end:
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

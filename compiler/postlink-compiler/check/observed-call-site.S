.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea sites(%rip), %rbx
    /* A runtime-selected row prevents local constant folding from repairing
     * the metadata observation accidentally. Normal invocation has argc=1. */
    mov (%rsp), %rcx
    dec %rcx
    lea (%rbx,%rcx,4), %rbx
    movslq (%rbx), %rax
    add %rbx, %rax
    /* Relative metadata refers to the exact five-byte CALL spelling, not
     * just to an equivalent function entry or an offset in a moved symbol. */
    cmpb $0xe8, (%rax)
    jne failed
    call *%rax
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
    /* No executable future enters this gap; compaction moves the next
     * function, so its interior site cannot retain the old numeric address. */
    .fill 1024, 1, 0xcc
.type wrapper, @function
wrapper:
    mov $3, %eax
    add $5, %eax
    shl $2, %eax
    xor %edi, %edi
.Lsite:
    call answer
    ret
.size wrapper, .-wrapper
.type answer, @function
answer:
    mov $42, %eax
    ret
.size answer, .-answer
.section .sites,"a",@progbits
sites:
    .long .Lsite-.
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

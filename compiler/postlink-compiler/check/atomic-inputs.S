.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea value(%rip), %rdi
    call probe
    cmp $1, %eax
    jne failed
    cmpq $0, (%rdi)
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
.type probe, @function
probe:
    /* The atomic compare consumes RDX:RAX even though both branch arms
     * discard RAX afterwards. Its replacement consumes RCX:RBX independently. */
    mov (%rdi), %r12
    mov 8(%rdi), %r13
    mov %r13, %r11
    mov %r13, %rax
    shr $16, %rax
    mov %ax, %r11w
    and $0x7fff, %r11w
    testb $1, enabled(%rip)
    jz atomic_failed
    mov %r11, %rcx
    mov %r13, %rdx
    xor %ebx, %ebx
    mov %r12, %rax
    cmpxchg16b (%rdi)
    jnz atomic_failed
    mov $1, %eax
    ret
atomic_failed:
    xor %eax, %eax
    ret
.size probe, .-probe
.section .data
.balign 16
value:
    .quad 0x0102030405060708, 0x1122334455667788
enabled:
    .byte 1
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

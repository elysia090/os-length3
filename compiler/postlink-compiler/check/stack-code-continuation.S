.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
#ifdef FAR_RETURN
    pushq $0x33
#endif
    /* GAS resolves this local LEA without a relocation. PUSH is a precise
     * memory cut; the continuation must survive across the preceding cut. */
    lea .Lresume(%rip), %rax
#ifdef COPY_ADDRESS
    mov %rax, %rdx
    xor %eax, %eax
    push %rdx
#else
    push %rax
#endif
#ifdef FAR_RETURN
    lretq
#else
    ret
#endif
.Lresume:
    mov $42, %edi
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start

.section .data
    /* Keep the input's retained relocation contract independent of the
     * local address under test. No constructor is an execution dependency. */
    .quad _start
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

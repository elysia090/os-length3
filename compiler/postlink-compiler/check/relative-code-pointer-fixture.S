.section .text
.globl _start
.type _start, @function
_start:
    /* Keep the product gate independent from the relocation property. */
    .rept 16
    nop
    .endr
    lea code_pointer(%rip), %rax
    movslq (%rax), %rbx
    add %rax, %rbx
    jmp *%rbx
.size _start, .-_start

.type destination, @function
destination:
    mov $60, %eax
    mov $42, %edi
    syscall
    ud2
.size destination, .-destination

.section .rodata,"a",@progbits
.p2align 2
code_pointer:
    /* ELF PC-relative data is S + A - P.  Unlike an x86 instruction
     * displacement, the consumer adds the field address, not its end. */
    .long destination - code_pointer

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits

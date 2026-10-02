.intel_syntax noprefix

.section .text
.globl _start
_start:
    movabs rdi, 0x1000000018
    # Reachable padding makes the standalone optimized ELF smaller.
    .rept 128
    nop
    .endr
    jmp quotient
quotient:
    mov r15, rdi
    sar r15, 3
    # Both published registers must zero their upper halves.
    mov esi, r15d
    mov r15d, r15d
    jmp check_value
check_value:
    mov rdx, 3
    imul rdx, r15
    cmp rdx, 9
    sete dil
    xor edi, 1
    mov eax, 60
    syscall

.section .text
.globl _start
.type _start, @function
_start:
    .rept 16
    nop
    .endr
    mov $handler_array, %rbp
    mov $2, %eax
    imul $9, %eax, %eax
    add %rax, %rbp
    jmp *%rbp
.size _start, .-_start

/* A linked code object can publish a finite, fixed-stride set of entry
 * coordinates without giving every cell an STT_FUNC symbol.  This is the
 * same ELF shape used by interrupt-stub arrays: cells that receive a hardware
 * error code need fewer instructions and are padded back to the public
 * stride. */
.macro near_jump target
    .byte 0xe9
    .long \target - . - 4
.endm

.globl handler_array
.type handler_array, @notype
handler_array:
    push $0
    push $0
    near_jump handler_common

    push $1
    near_jump handler_common
    int3
    int3

    push $0
    push $2
    near_jump handler_common

    push $3
    near_jump handler_common
    int3
    int3
.size handler_array, .-handler_array

.type handler_common, @function
handler_common:
    pop %rdi
    pop %rcx
    add $40, %edi
    mov $60, %eax
    syscall
    ud2
.size handler_common, .-handler_common

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits

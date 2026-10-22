.section .text
.globl _start
.type _start, @function
_start:
    /* Keep the product gate independent from the observed-span property. */
    .rept 16
    nop
    .endr
    lea patch_cell(%rip), %rax
    cmpw $0xb90f, 5(%rax)
    jne failed
    cmpb $0xcc, 7(%rax)
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

/* Execution ends at RET, but the explicit symbol extent publishes a finite
 * byte signature after it.  A consumer that materializes the symbol address
 * can inspect or patch that tail without executing it. */
.globl patch_cell
.type patch_cell, @function
patch_cell:
    ret
    int3
    nop
    nop
    nop
    .byte 0x0f, 0xb9, 0xcc
.size patch_cell, .-patch_cell

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits

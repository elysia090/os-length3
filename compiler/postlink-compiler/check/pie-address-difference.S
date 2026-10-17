/* A PIE address keeps its load bias across arithmetic.  The pointer returned
 * by provide and the RIP-relative anchor are in the same image; replacing
 * the second one with its linked numeric offset makes the result depend on
 * the runtime load address. */
.section .rodata
.balign 8
anchor:
    .quad 0, 0, 0

.section .text
.globl _start
.type _start,@function
_start:
    lea anchor+16(%rip), %rdi
    call provide
    lea anchor(%rip), %rdx
    sub %rdx, %rax
    cmp $16, %rax
    jne wrong
    mov $42, %edi
    jmp done
wrong:
    mov $1, %edi
done:
    mov $60, %eax
    syscall
.size _start, .-_start

.type provide,@function
provide:
    mov %rdi, %rax
    ret
.size provide, .-provide

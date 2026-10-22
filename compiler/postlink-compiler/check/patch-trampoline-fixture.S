.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea trampoline(%rip), %rbx
    cmpb $0x0f, 5(%rbx)
    jne failed
    cmpb $0xb9, 6(%rbx)
    jne failed
    cmpb $0xcc, 7(%rbx)
    jne failed
    call trampoline
    cmp $42, %eax
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

.globl trampoline
.type trampoline, @function
trampoline:
    .byte 0xe9
    .long target - . - 4
    .byte 0x0f, 0xb9, 0xcc
.size trampoline, .-trampoline

.type target, @function
target:
    mov $42, %eax
    ret
.size target, .-target

.section .data
.quad trampoline

.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc

.section .note.GNU-stack,"",@progbits

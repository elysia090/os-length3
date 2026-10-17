.text
.globl _start
.type _start, @function
_start:
    lea table(%rip), %rax
    mov $60, %eax
    xor %edi, %edi
    syscall
.size _start, .-_start

/* The allocated data section is addressed by code, but this rel32 word is
 * not a proved dispatch row. Its S+A happens to name the middle of an x86
 * instruction; admitting it as an execution root fabricates a bogus call. */
target:
    .byte 0xc1, 0xe8, 0x18, 0xc3

.section .rodata,"a",@progbits
table:
    .long target+1-.

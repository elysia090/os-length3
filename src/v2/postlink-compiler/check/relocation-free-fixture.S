.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    .rept 32
    nop
    .endr
    mov $60, %eax
    xor %edi, %edi
    syscall
.size _start, .-_start

/* Construction-only bytes give this deliberately tiny executable a strict
 * whole-file size win without adding a relocation or runtime dependency. */
.section .debug.padding,"",@progbits
.fill 4096, 1, 0

.section .note.GNU-stack,"",@progbits

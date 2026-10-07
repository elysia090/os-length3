/* Genuine public functions and ordinary construction relocations retain
 * neighbor fetch context after postlink removes unobserved padding. */
.text
.globl _start
.type _start,@function
_start:
    fucomip %st(0),%st
    ret
.size _start,.-_start
.altmacro
.macro CONTEXT n
.text
.globl image_fpu_context_\n
.type image_fpu_context_\n,@function
image_fpu_context_\n:
    mov $\n,%eax
    ret
.size image_fpu_context_\n,.-image_fpu_context_\n
.section .rodata,"a",@progbits
    .quad image_fpu_context_\n
.endm
.set number,1
.rept 4
    CONTEXT %number
    .set number,number+1
.endr
.section .note.GNU-stack,"",@progbits

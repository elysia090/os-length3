/* Public functions and ordinary construction relocations retain neighbor
 * fetch context after postlink removes unobserved alignment padding. */
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
.text
.globl image_fpu_single
.type image_fpu_single,@function
image_fpu_single:
    fcomps (%rdi)
    ret
.size image_fpu_single,.-image_fpu_single
.globl image_fpu_double
.type image_fpu_double,@function
image_fpu_double:
    fcompl (%rdi)
    ret
.size image_fpu_double,.-image_fpu_double
.globl image_fpu_integer
.type image_fpu_integer,@function
image_fpu_integer:
    ficomps (%rdi)
    ret
.size image_fpu_integer,.-image_fpu_integer
.globl image_fpu_zero
.type image_fpu_zero,@function
image_fpu_zero:
    ftst
    ret
.size image_fpu_zero,.-image_fpu_zero
.section .rodata,"a",@progbits
    .quad image_fpu_single,image_fpu_double,image_fpu_integer,image_fpu_zero
.section .note.GNU-stack,"",@progbits

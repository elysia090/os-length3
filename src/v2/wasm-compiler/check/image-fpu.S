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
.globl image_fpu_add
.type image_fpu_add,@function
image_fpu_add:
    /* FADD ST(0), ST(1), independent of assembler subtraction dialect. */
    .byte 0xd8,0xc1
    ret
.size image_fpu_add,.-image_fpu_add
.globl image_fpu_sub
.type image_fpu_sub,@function
image_fpu_sub:
    /* FSUB ST(5), ST(0): the published make's original DC ED source. */
    .byte 0xdc,0xed
    ret
.size image_fpu_sub,.-image_fpu_sub
.globl image_fpu_reverse_pop
.type image_fpu_reverse_pop,@function
image_fpu_reverse_pop:
    /* FSUBRP ST(1), ST(0). */
    .byte 0xde,0xe1
    ret
.size image_fpu_reverse_pop,.-image_fpu_reverse_pop
.globl image_fpu_alias_pop
.type image_fpu_alias_pop,@function
image_fpu_alias_pop:
    /* FADDP ST(0), ST(0): result and pop use the same physical register. */
    .byte 0xde,0xc0
    ret
.size image_fpu_alias_pop,.-image_fpu_alias_pop
.section .rodata,"a",@progbits
    .quad image_fpu_single,image_fpu_double,image_fpu_integer,image_fpu_zero
    .quad image_fpu_add,image_fpu_sub,image_fpu_reverse_pop,image_fpu_alias_pop
/* A real retained neighbor supplies the C0 interior coordinate's immediate;
 * do not satisfy source-fetch context with invented executable padding. */
    CONTEXT 5
.section .note.GNU-stack,"",@progbits

/* Distinct public functions and ordinary construction relocations keep a
 * genuine multi-module final code domain. No forged proof/symbol metadata. */
.altmacro
.macro FUNCTION n
.text
.globl image_function_\n
.type image_function_\n,@function
image_function_\n:
    mov $\n,%eax
    ret
.size image_function_\n,.-image_function_\n
.section .rodata,"a",@progbits
    .quad image_function_\n
.endm
.set number,0
.rept 64
    FUNCTION %number
    .set number,number+1
.endr
.globl _start
.set _start,image_function_0
.section .note.GNU-stack,"",@progbits

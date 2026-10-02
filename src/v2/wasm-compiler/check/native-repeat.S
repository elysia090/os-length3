/* Hardware-only oracle thunks. No guest execution path calls this file. */
.text
.macro repeat name, instruction
.globl \name
.type \name,@function
\name:
    rep \instruction
    ret
.size \name,.-\name
.endm
repeat native_repeat_8_64,movsb
repeat native_repeat_16_64,movsw
repeat native_repeat_32_64,movsl
repeat native_repeat_64_64,movsq
.macro repeat32 name, instruction
.globl \name
.type \name,@function
\name:
    addr32 rep \instruction
    ret
.size \name,.-\name
.endm
repeat32 native_repeat_8_32,movsb
repeat32 native_repeat_16_32,movsw
repeat32 native_repeat_32_32,movsl
repeat32 native_repeat_64_32,movsq
.section .note.GNU-stack,"",@progbits

.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    mov $60, %eax
    xor %edi, %edi
    syscall
.size _start, .-_start

/* A relocation field is construction history, not an independently
 * executable coordinate.  Starting at the opcode byte below also decodes as
 * a different, longer x86 instruction, so a backward scan from the field
 * cannot prove whether the operand-size prefix belongs to the instruction. */
.type relocation_source_only,@function
.section .text.relocation_source,"ax",@progbits
relocation_source_only:
    testw $0xffff, relocation_data(%rip)
    ret
.size relocation_source_only, .-relocation_source_only

.section .data.relocation_source,"aw",@progbits
.type relocation_data,@object
relocation_data:
    .word 0
.size relocation_data, .-relocation_data

.section .note.GNU-stack,"",@progbits

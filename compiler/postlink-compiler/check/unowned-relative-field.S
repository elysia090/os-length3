/* A referenced rel32 row points inside an unreachable LEA. Its ModRM byte
 * also decodes as XOR's opcode when viewed out of context. Neither that
 * overlapping immediate spelling nor the data row publishes an entry. */
.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea field_record(%rip), %rax
    mov $42, %edi
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start
.type unused, @function
unused:
#ifdef MIXED_DATA_FIELD
    movabs $0x0123456789abcdef, %rax
#else
    lea datum(%rip), %rax
#endif
    ret
.size unused, .-unused
#ifdef MIXED_DATA_FIELD
.section .rodata
field_record:
    .long unused+2-.
#else
.section .field_records,"a",@progbits
field_record:
    .long unused+3-.
.section .rodata
#endif
datum:
    .byte 0
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

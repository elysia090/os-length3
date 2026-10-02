/* The LEA displacement begins with E9, but it is not a jump instruction.
 * An unrelated data relocation's S+A points at that byte. The accidental
 * five-byte decode jumps outside the executable image and supplies no entry
 * authority. Decoding XOR from its ModRM does not turn the displacement into
 * an immediate field either. The program exits with 42. */
.section .text
.globl _start
.type _start, @function
_start:
.Lowner:
    leaq .Ldatum(%rip), %rax
    nop
    movl $42, %edi
    movl $60, %eax
    syscall
.size _start, .-_start

.section .rodata
.Lrecord:
    .long .Lowner + 3 - .Lrecord
    .space 236
.Ldatum:
    .byte 0

.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.space 4096

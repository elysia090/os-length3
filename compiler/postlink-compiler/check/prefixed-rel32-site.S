/* A rel32 datum names the E8 byte after an address-size prefix. It does not
 * publish another execution boundary inside the six-byte CALL instruction. */
.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea record(%rip), %rbx
    call wrapper
    mov %eax, %edi
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start
.type wrapper, @function
wrapper:
    .byte 0x67
    call answer
    ret
.size wrapper, .-wrapper
.type answer, @function
answer:
    mov $42, %eax
    ret
.size answer, .-answer
.section .patch_coords,"a",@progbits
record:
    .long wrapper+1-.
.section .text.unreachable,"ax",@progbits
.fill 16384, 1, 0xcc
.section .note.GNU-stack,"",@progbits

/* A shifted index is published in RDX before it is used as an address.
 * The LEA must consume that published value exactly once, not fold the
 * earlier shift into its scale while leaving the shift in place. */
.intel_syntax noprefix
.global _start
.global scaled_address_start
.section .text
_start:
    mov rdx, qword ptr [rip + index_value]
    mov rdi, qword ptr [rip + base_pointer]
    mov r12, qword ptr [rip + side_value]
scaled_address_start:
    shl rdx, 2
    lea r8, [rdi + rdx]
    mov rsi, r12
    mov r10d, dword ptr [r8]
    cmp r10d, 123
    jne failed
    cmp rdx, 4
    jne failed
    cmp rsi, 7
    jne failed
    xor edi, edi
    jmp exit
failed:
    mov edi, 1
exit:
    mov eax, 60
    syscall
    .rept 4096
    nop
    .endr
.section .data
index_value: .quad 1
base_pointer: .quad values
side_value: .quad 7
values:
    .long 99, 123, 77, 88, 555, 66
.section .note.GNU-stack,"",@progbits

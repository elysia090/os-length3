/* A conditional move reads the old EDX through its EBX publication.
 * Reusing EDX after writing the old R9D there changes the selected arm. */
.intel_syntax noprefix
.global _start
.global conditional_entry_alias_start
.text
_start:
    mov edx, DWORD PTR [rip + old_edx]
    mov r8d, DWORD PTR [rip + old_r8]
    mov r9d, DWORD PTR [rip + old_r9]
conditional_entry_alias_start:
    mov ebx, edx
    mov edx, r9d
    mov r9d, r8d
    cmp ebx, r8d
    cmovae r9d, ebx
    cmp r9d, 3
    jne failed
    cmp edx, 100
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
.data
old_edx: .long 3
old_r8: .long 2
old_r9: .long 100
.section .note.GNU-stack,"",@progbits

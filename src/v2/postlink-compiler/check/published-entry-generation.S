/* RDI aliases the entry value of RAX, but R14 also reads that old value.
 * The scaled RAX publication must not be scheduled before R14. */
.intel_syntax noprefix
.global _start
.global published_entry_generation_start
.text
_start:
    lea rdx, [rip + state]
    mov eax, DWORD PTR [rdx + 4]
    mov r8d, DWORD PTR [rdx]
published_entry_generation_start:
    lea r15, [rdx + 8]
    mov rdi, rax
    lea r14d, [rax + 1]
    and r8d, 0x7fffffff
    lea rax, [rax + rax * 4]
    lea rbx, [rax * 8 + 8]
    cmp edi, r8d
    jne failed
    cmp rax, 5
    jne failed
    cmp r14d, 2
    jne failed
    cmp rbx, 48
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
state:
    .long 1, 1
.section .note.GNU-stack,"",@progbits

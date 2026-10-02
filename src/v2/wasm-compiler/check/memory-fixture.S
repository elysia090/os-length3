#ifndef MEMORY_CASE
#define MEMORY_CASE 0
#endif
.intel_syntax noprefix
.text
.global _start
.type _start,@function
_start:
#if MEMORY_CASE == 0
    mov rax, [rdi]
#elif MEMORY_CASE == 1
    mov eax, [rdi]
#elif MEMORY_CASE == 2
    mov ax, [rdi]
#elif MEMORY_CASE == 3
    mov al, [rdi]
#elif MEMORY_CASE == 4
    mov ah, [rdi]
#elif MEMORY_CASE == 5
    mov [rdi], rax
#elif MEMORY_CASE == 6
    mov [rdi], eax
#elif MEMORY_CASE == 7
    mov [rdi], ax
#elif MEMORY_CASE == 8
    mov [rdi], al
#elif MEMORY_CASE == 9
    mov [rdi], ah
#elif MEMORY_CASE == 10
    movsx rax, byte ptr [rdi]
#elif MEMORY_CASE == 11
    movsx eax, word ptr [rdi]
#elif MEMORY_CASE == 12
    movsxd rax, dword ptr [rdi]
#elif MEMORY_CASE == 13
    movzx eax, byte ptr [rdi]
#elif MEMORY_CASE == 14
    movzx rax, word ptr [rdi]
#elif MEMORY_CASE == 15
    mov qword ptr [rdi], -123
#elif MEMORY_CASE == 16
    mov rdi, [rdi]
#elif MEMORY_CASE == 17
    mov rax, [rdi + rcx*4 + 7]
#elif MEMORY_CASE == 18
    mov rax, [edi]
#elif MEMORY_CASE == 19
    mov rax, [rbp]
#elif MEMORY_CASE == 20
    lea rdi, [rdi + 8]
    mov rax, [rdi]
#elif MEMORY_CASE == 21
    mov rax, [rip + 8]
#elif MEMORY_CASE == 22
    mov rax, qword ptr fs:[rdi]
#else
#error unsupported case
#endif
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits

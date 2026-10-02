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
#elif MEMORY_CASE >= 23 && MEMORY_CASE <= 42
#if (MEMORY_CASE - 23) % 4 == 0
#define DEST qword ptr [rdi]
#define SOURCE rax
#elif (MEMORY_CASE - 23) % 4 == 1
#define DEST dword ptr [rdi]
#define SOURCE eax
#elif (MEMORY_CASE - 23) % 4 == 2
#define DEST word ptr [rdi]
#define SOURCE ax
#else
#define DEST byte ptr [rdi]
#define SOURCE al
#endif
#if MEMORY_CASE < 27
    add DEST, SOURCE
#elif MEMORY_CASE < 31
    sub DEST, SOURCE
#elif MEMORY_CASE < 35
    and DEST, SOURCE
#elif MEMORY_CASE < 39
    or DEST, SOURCE
#else
    xor DEST, SOURCE
#endif
#elif MEMORY_CASE == 43
    add qword ptr [rdi], rdi
#elif MEMORY_CASE == 44
    add qword ptr [rdi], -123
#elif MEMORY_CASE == 45
    lock add qword ptr [rdi], rax
#else
#error unsupported case
#endif
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits

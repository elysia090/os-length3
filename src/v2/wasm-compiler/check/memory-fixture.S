#ifndef MEMORY_CASE
#define MEMORY_CASE 0
#endif
.intel_syntax noprefix
.text
.global _start
.type _start,@function
_start:
#if defined(MEMORY_CMOV)
#if MEMORY_WIDTH == 16
#define DEST ax
#define SOURCE word ptr [rdi]
#elif MEMORY_WIDTH == 32
#define DEST eax
#define SOURCE dword ptr [rdi]
#else
#define DEST rax
#define SOURCE qword ptr [rdi]
#endif
#if MEMORY_CMOV_CASE == 1
    MEMORY_CMOV rdi, qword ptr [rdi]
#elif MEMORY_CMOV_CASE == 2
    MEMORY_CMOV edi, dword ptr [edi]
#elif MEMORY_CMOV_CASE == 3
    MEMORY_CMOV rbp, qword ptr [rbp]
#elif MEMORY_CMOV_CASE == 4
    MEMORY_CMOV eax, dword ptr [rdi + rcx*4 + 7]
#elif MEMORY_CMOV_CASE == 5
    MEMORY_CMOV r9w, word ptr [rdi]
    mov rax,r9
#elif MEMORY_CMOV_CASE == 6
    MEMORY_CMOV rax, qword ptr [rip + 8]
#elif MEMORY_CMOV_CASE == 7
    MEMORY_CMOV rax, qword ptr fs:[rdi]
#else
    MEMORY_CMOV DEST,SOURCE
#endif
#elif MEMORY_CASE == 0
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
#elif MEMORY_CASE == 46
    cmp byte ptr [rdi + 0x1ef], 0
#elif MEMORY_CASE == 47
    cmp word ptr [rdi], -1
#elif MEMORY_CASE == 48
    cmp dword ptr [rdi], r9d
#elif MEMORY_CASE == 49
    cmp qword ptr [rdi], r11
#elif MEMORY_CASE == 50
    cmp al, byte ptr [rdi]
#elif MEMORY_CASE == 51
    cmp ax, word ptr [rdi]
#elif MEMORY_CASE == 52
    cmp r9d, dword ptr [rdi]
#elif MEMORY_CASE == 53
    cmp r11, qword ptr [rdi]
#elif MEMORY_CASE == 54
    test byte ptr [rdi], ah
#elif MEMORY_CASE == 55
    test word ptr [rdi], ax
#elif MEMORY_CASE == 56
    test dword ptr [rdi], r9d
#elif MEMORY_CASE == 57
    test qword ptr [rdi], r11
#elif MEMORY_CASE == 58
    test byte ptr [rdi], 0x80
#elif MEMORY_CASE == 59
    test word ptr [rdi], 0x8001
#elif MEMORY_CASE == 60
    test dword ptr [edi], 0x80000001
#elif MEMORY_CASE == 61
    test qword ptr [rdi + rcx*4 + 7], -123
#elif MEMORY_CASE >= 62 && MEMORY_CASE <= 81
#if (MEMORY_CASE - 62) % 4 == 0
#define DEST rax
#define SOURCE qword ptr [rdi]
#elif (MEMORY_CASE - 62) % 4 == 1
#define DEST eax
#define SOURCE dword ptr [rdi]
#elif (MEMORY_CASE - 62) % 4 == 2
#define DEST ax
#define SOURCE word ptr [rdi]
#else
#define DEST al
#define SOURCE byte ptr [rdi]
#endif
#if MEMORY_CASE < 66
    add DEST, SOURCE
#elif MEMORY_CASE < 70
    sub DEST, SOURCE
#elif MEMORY_CASE < 74
    and DEST, SOURCE
#elif MEMORY_CASE < 78
    or DEST, SOURCE
#else
    xor DEST, SOURCE
#endif
#elif MEMORY_CASE == 82
    add ah, byte ptr [rdi]
#elif MEMORY_CASE == 83
    add rdi, qword ptr [rdi]
#elif MEMORY_CASE == 84
    sub eax, dword ptr [rdi + rcx*4 + 7]
#elif MEMORY_CASE == 85
    or edi, dword ptr [edi]
#elif MEMORY_CASE == 86
    xor rbp, qword ptr [rbp]
#elif MEMORY_CASE == 87
    add rax, qword ptr [rip + 8]
#elif MEMORY_CASE == 88
    add rax, qword ptr fs:[rdi]
#elif MEMORY_CASE >= 89 && MEMORY_CASE <= 100
#if (MEMORY_CASE - 89) % 3 == 0
#define DEST word ptr [rdi]
#elif (MEMORY_CASE - 89) % 3 == 1
#define DEST dword ptr [rdi]
#else
#define DEST qword ptr [rdi]
#endif
#if MEMORY_CASE < 92
    bt DEST, 255
#elif MEMORY_CASE < 95
    bts DEST, 255
#elif MEMORY_CASE < 98
    btr DEST, 255
#else
    btc DEST, 255
#endif
#elif MEMORY_CASE == 101
    bts qword ptr [rip + 8], 63
#elif MEMORY_CASE == 102
    bts word ptr [edi], 16
#elif MEMORY_CASE == 103
    btr qword ptr [rdi + rcx*4 + 7], 67
#elif MEMORY_CASE == 104
    btc qword ptr [rbp], 0
#elif MEMORY_CASE == 105
    bt dword ptr [rdi], 35
#elif MEMORY_CASE == 106
    bts qword ptr [rdi], 63
#elif MEMORY_CASE >= 107 && MEMORY_CASE <= 122
#if (MEMORY_CASE - 107) % 4 == 0
#define DEST byte ptr [rdi]
#elif (MEMORY_CASE - 107) % 4 == 1
#define DEST word ptr [rdi]
#elif (MEMORY_CASE - 107) % 4 == 2
#define DEST dword ptr [rdi]
#else
#define DEST qword ptr [rdi]
#endif
#if MEMORY_CASE < 111
    inc DEST
#elif MEMORY_CASE < 115
    dec DEST
#elif MEMORY_CASE < 119
    neg DEST
#else
    not DEST
#endif
#elif MEMORY_CASE == 123
    inc dword ptr [rip + 8]
#elif MEMORY_CASE == 124
    dec word ptr [edi]
#elif MEMORY_CASE == 125
    neg qword ptr [rdi + rcx*4 + 7]
#elif MEMORY_CASE == 126
    not byte ptr [rbp]
#elif MEMORY_CASE == 127
    inc qword ptr [r12]
#elif MEMORY_CASE == 128
    dec qword ptr [rip + 8]
#else
#error unsupported case
#endif
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits

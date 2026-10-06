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
#elif MEMORY_CASE == 129
    cmpxchg byte ptr [rdi], cl
#elif MEMORY_CASE == 130
    cmpxchg word ptr [rdi], cx
#elif MEMORY_CASE == 131
    cmpxchg dword ptr [rdi], ecx
#elif MEMORY_CASE == 132
    cmpxchg qword ptr [rdi], rcx
#elif MEMORY_CASE == 133
    cmpxchg byte ptr [rdi], ah
#elif MEMORY_CASE == 134
    cmpxchg byte ptr [rdi], al
#elif MEMORY_CASE == 135
    cmpxchg word ptr [rdi], ax
#elif MEMORY_CASE == 136
    cmpxchg dword ptr [rdi], eax
#elif MEMORY_CASE == 137
    cmpxchg qword ptr [rdi], rax
#elif MEMORY_CASE == 138
    cmpxchg qword ptr [rax], rcx
#elif MEMORY_CASE == 139
    cmpxchg byte ptr [rdi + rax*2 + 7], cl
#elif MEMORY_CASE == 140
    cmpxchg dword ptr [rdi + rcx*4 + 7], ecx
#elif MEMORY_CASE == 141
    cmpxchg word ptr [edi], cx
#elif MEMORY_CASE == 142
    cmpxchg dword ptr [rbp], r11d
#elif MEMORY_CASE == 143
    cmpxchg qword ptr [r12], r9
#elif MEMORY_CASE == 144
    cmpxchg qword ptr [rip + 8], r9
#elif MEMORY_CASE == 145
    cmpxchg dword ptr [rip + 8], ecx
#elif MEMORY_CASE == 146
    cmpxchg byte ptr ss:[rdi], cl
#elif MEMORY_CASE == 147
    cmpxchg qword ptr [rdi + rcx*8 + 7], r8
#elif MEMORY_CASE == 148
    cmpxchg qword ptr [rbx + 24], r9
#elif MEMORY_CASE == 149
    lock cmpxchg byte ptr [rdi], cl
#elif MEMORY_CASE == 150
    lock cmpxchg word ptr [rdi], cx
#elif MEMORY_CASE == 151
    lock cmpxchg dword ptr [rdi], ecx
#elif MEMORY_CASE == 152
    lock cmpxchg qword ptr [rdi], rcx
#elif MEMORY_CASE == 153
    lock cmpxchg byte ptr [rdi], ah
#elif MEMORY_CASE == 154
    lock cmpxchg qword ptr [rax], rcx
#elif MEMORY_CASE == 155
    lock cmpxchg dword ptr [rdi + rcx*4 + 7], ecx
#elif MEMORY_CASE == 156
    lock cmpxchg qword ptr [rbx + 24], r9
#elif MEMORY_CASE == 157
    lock cmpxchg qword ptr [rip + 8], r9
#elif MEMORY_CASE == 158
    lock cmpxchg word ptr [edi], cx
#elif MEMORY_CASE == 159
    lock cmpxchg dword ptr [rbp], r11d
#elif MEMORY_CASE == 160
    lock cmpxchg qword ptr [r12], r9
#elif MEMORY_CASE >= 161 && MEMORY_CASE <= 176
    /* The opcode's condition rank is independent of the addressing mode. */
    .byte 0x0f, 0x90 + (MEMORY_CASE - 161), 0x07
#elif MEMORY_CASE == 177
    setle byte ptr [edi]
#elif MEMORY_CASE == 178
    setg byte ptr [rbp]
#elif MEMORY_CASE == 179
    setb byte ptr [r12]
#elif MEMORY_CASE == 180
    seta byte ptr [rdi + rcx*4 + 7]
#elif MEMORY_CASE == 181
    setne byte ptr [rip + 8]
#elif MEMORY_CASE == 182
    setp byte ptr ss:[rdi]
#elif MEMORY_CASE == 183
    sets byte ptr [r12 + r9*8 + 7]
#elif MEMORY_CASE == 184
    .byte 0x0f, 0x94, 0x3f /* ModRM.reg is ignored; still SETE [RDI]. */
#elif MEMORY_CASE == 185
    .byte 0x66, 0x48, 0x0f, 0x94, 0x07 /* Operand stays 8-bit. */
#elif MEMORY_CASE >= 186 && MEMORY_CASE <= 209
#if (MEMORY_CASE-186)%6 < 3
#define ADDRESS [rdi]
#else
#define ADDRESS [edi]
#endif
#if (MEMORY_CASE-186)%3 == 0
#define DEST word ptr ADDRESS
#define INDEX cx
#elif (MEMORY_CASE-186)%3 == 1
#define DEST dword ptr ADDRESS
#define INDEX ecx
#else
#define DEST qword ptr ADDRESS
#define INDEX rcx
#endif
#if MEMORY_CASE < 192
    bt DEST, INDEX
#elif MEMORY_CASE < 198
    bts DEST, INDEX
#elif MEMORY_CASE < 204
    btr DEST, INDEX
#else
    btc DEST, INDEX
#endif
#elif MEMORY_CASE >= 210 && MEMORY_CASE <= 221
#if MEMORY_CASE < 214
#define DEST qword ptr [rip+512]
#define INDEX rdi
#elif MEMORY_CASE < 218
#define DEST qword ptr [rdi+rcx*4+7]
#define INDEX rcx
#else
#define DEST word ptr [rbp]
#define INDEX cx
#endif
#if (MEMORY_CASE-210)%4 == 0
    bt DEST, INDEX
#elif (MEMORY_CASE-210)%4 == 1
    bts DEST, INDEX
#elif (MEMORY_CASE-210)%4 == 2
    btr DEST, INDEX
#else
    btc DEST, INDEX
#endif
#elif MEMORY_CASE == 222
    bts dword ptr [r12+r9*8+7], r9d
#elif MEMORY_CASE == 223
    btc qword ptr ss:[rdi], r11
#elif MEMORY_CASE >= 224 && MEMORY_CASE <= 271
#if (MEMORY_CASE-224)%6 < 3
#define ADDRESS [rdi]
#else
#define ADDRESS [edi]
#endif
#if (MEMORY_CASE-224)%3 == 0
#define DEST ax
#define SOURCE word ptr ADDRESS
#elif (MEMORY_CASE-224)%3 == 1
#define DEST eax
#define SOURCE dword ptr ADDRESS
#else
#define DEST rax
#define SOURCE qword ptr ADDRESS
#endif
#if (MEMORY_CASE-224)/6 == 0
    imul DEST, SOURCE
#elif (MEMORY_CASE-224)/6 == 1
    imul DEST, SOURCE, 24
#elif (MEMORY_CASE-224)/6 == 2
    imul DEST, SOURCE, -128
#elif (MEMORY_CASE-224)/6 == 3
    imul DEST, SOURCE, 128
#elif (MEMORY_CASE-224)/6 == 4
    imul DEST, SOURCE, 0
#elif (MEMORY_CASE-224)/6 == 5
    imul DEST, SOURCE, 1
#elif (MEMORY_CASE-224)/6 == 6
    imul DEST, SOURCE, -32768
#else
    imul DEST, SOURCE, 32767
#endif
#elif MEMORY_CASE == 272
    imul rdi, qword ptr [rdi]
#elif MEMORY_CASE == 273
    imul edi, dword ptr [edi]
#elif MEMORY_CASE == 274
    imul di, word ptr [rdi]
#elif MEMORY_CASE == 275
    imul rbp, qword ptr [rbp]
#elif MEMORY_CASE == 276
    imul r12, qword ptr [r12]
#elif MEMORY_CASE == 277
    imul r9, qword ptr [rdi+r9*8+7]
#elif MEMORY_CASE == 278
    imul rax, qword ptr [rip+512], 24
#elif MEMORY_CASE == 279
    imul r10d, dword ptr [rip+512], -128
#elif MEMORY_CASE == 280
    imul cx, word ptr ss:[rdi+r11*2+7], -128
#elif MEMORY_CASE >= 281 && MEMORY_CASE <= 312
#if (MEMORY_CASE-281)/8 < 2
#define PRODUCT mul
#else
#define PRODUCT imul
#endif
#if (MEMORY_CASE-281)%8 < 4
#if (MEMORY_CASE-281)%16 < 8
#define ADDRESS [rdi]
#else
#define ADDRESS [rbx]
#endif
#else
#if (MEMORY_CASE-281)%16 < 8
#define ADDRESS [edi]
#else
#define ADDRESS [ebx]
#endif
#endif
#if (MEMORY_CASE-281)%4 == 0
    PRODUCT byte ptr ADDRESS
#elif (MEMORY_CASE-281)%4 == 1
    PRODUCT word ptr ADDRESS
#elif (MEMORY_CASE-281)%4 == 2
    PRODUCT dword ptr ADDRESS
#else
    PRODUCT qword ptr ADDRESS
#endif
#elif MEMORY_CASE == 313
    mul qword ptr [rax]
#elif MEMORY_CASE == 314
    imul qword ptr [rax]
#elif MEMORY_CASE == 315
    mul qword ptr [rdx]
#elif MEMORY_CASE == 316
    imul qword ptr [rdx]
#elif MEMORY_CASE == 317
    mul byte ptr [r12]
#elif MEMORY_CASE == 318
    imul byte ptr [r12]
#elif MEMORY_CASE == 319
    mul word ptr ss:[rbp]
#elif MEMORY_CASE == 320
    imul word ptr ss:[rbp]
#elif MEMORY_CASE == 321
    mul dword ptr [rdi+rcx*4+7]
#elif MEMORY_CASE == 322
    imul dword ptr [rdi+rcx*4+7]
#elif MEMORY_CASE == 323
    mul qword ptr [rip+512]
#elif MEMORY_CASE == 324
    imul qword ptr [rip+512]
#elif MEMORY_CASE == 325
    mul qword ptr [rdi+rax*8+7]
#elif MEMORY_CASE == 326
    imul qword ptr [rdi+rax*8+7]
#elif MEMORY_CASE >= 327 && MEMORY_CASE <= 390
#if MEMORY_CASE < 359
#define TRANSFER xadd
#else
#define TRANSFER xchg
#endif
#define TRANSFER_RANK ((MEMORY_CASE-327)%32)
#if TRANSFER_RANK >= 16
    lock
#endif
#if (TRANSFER_RANK/8)%2
#define TRANSFER_ADDRESS [edi]
#else
#define TRANSFER_ADDRESS [rdi]
#endif
#if (TRANSFER_RANK/4)%2
#if TRANSFER_RANK%4 == 0
    TRANSFER byte ptr TRANSFER_ADDRESS, cl
#elif TRANSFER_RANK%4 == 1
    TRANSFER word ptr TRANSFER_ADDRESS, cx
#elif TRANSFER_RANK%4 == 2
    TRANSFER dword ptr TRANSFER_ADDRESS, ecx
#else
    TRANSFER qword ptr TRANSFER_ADDRESS, rcx
#endif
#else
#if TRANSFER_RANK%4 == 0
    TRANSFER byte ptr TRANSFER_ADDRESS, al
#elif TRANSFER_RANK%4 == 1
    TRANSFER word ptr TRANSFER_ADDRESS, ax
#elif TRANSFER_RANK%4 == 2
    TRANSFER dword ptr TRANSFER_ADDRESS, eax
#else
    TRANSFER qword ptr TRANSFER_ADDRESS, rax
#endif
#endif
#elif MEMORY_CASE == 391
    xadd qword ptr [rax], rax
#elif MEMORY_CASE == 392
    lock xadd dword ptr [rax], eax
#elif MEMORY_CASE == 393
    xadd qword ptr [rdx], rdx
#elif MEMORY_CASE == 394
    xadd byte ptr [rax], ah
#elif MEMORY_CASE == 395
    xadd qword ptr [rdi+rcx*4+7], rcx
#elif MEMORY_CASE == 396
    xadd qword ptr [rip+512], rax
#elif MEMORY_CASE == 397
    xchg qword ptr [rax], rax
#elif MEMORY_CASE == 398
    xchg dword ptr [rax], eax
#elif MEMORY_CASE == 399
    xchg qword ptr [rdx], rdx
#elif MEMORY_CASE == 400
    xchg byte ptr [rax], ah
#elif MEMORY_CASE == 401
    xchg qword ptr ss:[rdi+r11*2+7], r11
#elif MEMORY_CASE == 402
    xchg qword ptr [rip+512], rax
#elif MEMORY_CASE >= 403 && MEMORY_CASE <= 458
/* Seven arithmetic families, four widths, register and signed immediate. */
#define LOCK_RANK (MEMORY_CASE-403)
#if LOCK_RANK%4 == 0
#define LOCK_DEST byte ptr [rdi]
#define LOCK_SOURCE r9b
#elif LOCK_RANK%4 == 1
#define LOCK_DEST word ptr [rdi]
#define LOCK_SOURCE r9w
#elif LOCK_RANK%4 == 2
#define LOCK_DEST dword ptr [rdi]
#define LOCK_SOURCE r9d
#else
#define LOCK_DEST qword ptr [rdi]
#define LOCK_SOURCE r9
#endif
#if (LOCK_RANK/4)%2
#undef LOCK_SOURCE
#define LOCK_SOURCE -123
#endif
#if LOCK_RANK/8 == 0
    lock add LOCK_DEST, LOCK_SOURCE
#elif LOCK_RANK/8 == 1
    lock or LOCK_DEST, LOCK_SOURCE
#elif LOCK_RANK/8 == 2
    lock adc LOCK_DEST, LOCK_SOURCE
#elif LOCK_RANK/8 == 3
    lock sbb LOCK_DEST, LOCK_SOURCE
#elif LOCK_RANK/8 == 4
    lock and LOCK_DEST, LOCK_SOURCE
#elif LOCK_RANK/8 == 5
    lock sub LOCK_DEST, LOCK_SOURCE
#else
    lock xor LOCK_DEST, LOCK_SOURCE
#endif
#elif MEMORY_CASE >= 459 && MEMORY_CASE <= 474
#define LOCK_RANK (MEMORY_CASE-459)
#if LOCK_RANK%4 == 0
#define LOCK_DEST byte ptr [rdi]
#elif LOCK_RANK%4 == 1
#define LOCK_DEST word ptr [rdi]
#elif LOCK_RANK%4 == 2
#define LOCK_DEST dword ptr [rdi]
#else
#define LOCK_DEST qword ptr [rdi]
#endif
#if LOCK_RANK/4 == 0
    lock inc LOCK_DEST
#elif LOCK_RANK/4 == 1
    lock dec LOCK_DEST
#elif LOCK_RANK/4 == 2
    lock neg LOCK_DEST
#else
    lock not LOCK_DEST
#endif
#elif MEMORY_CASE >= 475 && MEMORY_CASE <= 483
#define LOCK_RANK (MEMORY_CASE-475)
#if LOCK_RANK%3 == 0
#define LOCK_DEST word ptr [rdi]
#define LOCK_SOURCE cx
#elif LOCK_RANK%3 == 1
#define LOCK_DEST dword ptr [rdi]
#define LOCK_SOURCE ecx
#else
#define LOCK_DEST qword ptr [rdi]
#define LOCK_SOURCE rcx
#endif
#if LOCK_RANK/3 == 0
    lock bts LOCK_DEST, LOCK_SOURCE
#elif LOCK_RANK/3 == 1
    lock btr LOCK_DEST, LOCK_SOURCE
#else
    lock btc LOCK_DEST, LOCK_SOURCE
#endif
#elif MEMORY_CASE == 484
    lock or qword ptr [rax+rcx*8], rdx
#elif MEMORY_CASE == 485
    lock xor byte ptr [rdi], ah
#elif MEMORY_CASE == 486
    lock add qword ptr [rdi], rdi
#elif MEMORY_CASE == 487
    lock adc dword ptr [edi], eax
#elif MEMORY_CASE == 488
    lock sub qword ptr [rdi+rcx*4+7], rcx
#elif MEMORY_CASE == 489
    lock and qword ptr [rip+512], -123
#elif MEMORY_CASE == 490
    lock or qword ptr [rdi], -2147483648
#elif MEMORY_CASE == 491
    lock xor word ptr [rdi], 0x8001
#elif MEMORY_CASE == 492
    lock not byte ptr [r12]
#elif MEMORY_CASE == 493
    lock btr qword ptr [rdi+r11*2+7], r11
#else
#error unsupported case
#endif
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits

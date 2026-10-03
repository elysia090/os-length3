/* All forms are ordinary linked x86 instructions, observed independently. */
.intel_syntax noprefix
.text
.global _start
.type _start,@function
#if MEMORY_WIDTH == 8
#define ACC al
#define OTHER cl
#define EXT r9b
#define SIZE byte
#elif MEMORY_WIDTH == 16
#define ACC ax
#define OTHER cx
#define EXT r9w
#define SIZE word
#elif MEMORY_WIDTH == 32
#define ACC eax
#define OTHER ecx
#define EXT r9d
#define SIZE dword
#else
#define ACC rax
#define OTHER rcx
#define EXT r9
#define SIZE qword
#endif
_start:
#if MEMORY_CARRY_CASE == 0
    MEMORY_CARRY ACC, SIZE ptr [rdi]
#elif MEMORY_CARRY_CASE == 1
    MEMORY_CARRY SIZE ptr [rdi], OTHER
#elif MEMORY_CARRY_CASE == 2
    MEMORY_CARRY SIZE ptr [rdi], 0
#elif MEMORY_CARRY_CASE == 3
    MEMORY_CARRY SIZE ptr [rdi], -1
#elif MEMORY_CARRY_CASE == 4
    MEMORY_CARRY SIZE ptr [rdi], -128
#elif MEMORY_CARRY_CASE == 5
    MEMORY_CARRY SIZE ptr [rdi], 128
#elif MEMORY_CARRY_CASE == 6
    MEMORY_CARRY ACC, SIZE ptr [edi]
#elif MEMORY_CARRY_CASE == 7
    MEMORY_CARRY SIZE ptr [edi], OTHER
#elif MEMORY_CARRY_CASE == 8
#if MEMORY_WIDTH == 8
    MEMORY_CARRY dil, byte ptr [rdi]
#elif MEMORY_WIDTH == 16
    MEMORY_CARRY di, word ptr [rdi]
#elif MEMORY_WIDTH == 32
    MEMORY_CARRY edi, dword ptr [edi]
#else
    MEMORY_CARRY rdi, qword ptr [rdi]
#endif
#elif MEMORY_CARRY_CASE == 9
    MEMORY_CARRY SIZE ptr [rdi+rcx*4+7], OTHER
#elif MEMORY_CARRY_CASE == 10
    MEMORY_CARRY ACC, SIZE ptr [rdi+rax*8+7]
#elif MEMORY_CARRY_CASE == 11
    MEMORY_CARRY SIZE ptr ss:[rbp], OTHER
#elif MEMORY_CARRY_CASE == 12 && MEMORY_WIDTH == 8
    MEMORY_CARRY ah, byte ptr [rdi]
#elif MEMORY_CARRY_CASE == 13 && MEMORY_WIDTH == 8
    MEMORY_CARRY byte ptr [rdi], ah
#elif MEMORY_CARRY_CASE == 14
    MEMORY_CARRY ACC, SIZE ptr [rip+512]
#elif MEMORY_CARRY_CASE == 15
    MEMORY_CARRY SIZE ptr [rip+512], OTHER
#elif MEMORY_CARRY_CASE == 16
    MEMORY_CARRY EXT, SIZE ptr [r12]
#elif MEMORY_CARRY_CASE == 17
    MEMORY_CARRY SIZE ptr [r12], EXT
#else
#error unsupported memory carry form
#endif
    ret
.size _start,.-_start
.section .note.GNU-stack,"",@progbits

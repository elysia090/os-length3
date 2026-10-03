/* Ordinary linked ELF forms; the native observer owns input/output evidence. */
.intel_syntax noprefix
.text
.global _start
.type _start,@function
#if MEMORY_WIDTH == 16
#define DEST ax
#define ALIAS di
#define EXT r9w
#define SIZE word
#elif MEMORY_WIDTH == 32
#define DEST eax
#define ALIAS edi
#define EXT r9d
#define SIZE dword
#else
#define DEST rax
#define ALIAS rdi
#define EXT r9
#define SIZE qword
#endif
#if SUMMARY_KIND == 0 || SUMMARY_KIND == 2
#define OP bsf
#elif SUMMARY_KIND == 1 || SUMMARY_KIND == 3
#define OP bsr
#else
#define OP popcnt
#endif
_start:
#if MEMORY_SUMMARY_CASE == 8
    mov rax,rax /* Pure prefix must commit before a possibly faulting read. */
#endif
#if SUMMARY_KIND == 2 || SUMMARY_KIND == 3
    .byte 0xf3 /* Legacy scan in the fixed no-BMI1/LZCNT CPU profile. */
#endif
#if MEMORY_SUMMARY_CASE == 0 || MEMORY_SUMMARY_CASE == 8
    OP DEST, SIZE ptr [rdi]
#elif MEMORY_SUMMARY_CASE == 1
    OP DEST, SIZE ptr [edi]
#elif MEMORY_SUMMARY_CASE == 2
    OP ALIAS, SIZE ptr [rdi]
#elif MEMORY_SUMMARY_CASE == 3
    OP DEST, SIZE ptr [rdi+rax*8+7]
#elif MEMORY_SUMMARY_CASE == 4
    OP DEST, SIZE ptr ss:[rbp+24]
#elif MEMORY_SUMMARY_CASE == 5
    OP EXT, SIZE ptr [r12+rcx*4+7]
#elif MEMORY_SUMMARY_CASE == 6
    OP DEST, SIZE ptr [rip+512]
#elif MEMORY_SUMMARY_CASE == 7
    OP ALIAS, SIZE ptr [edi]
#else
#error unsupported memory summary form
#endif
    ret
    .zero 1024
.size _start,.-_start
.section .note.GNU-stack,"",@progbits

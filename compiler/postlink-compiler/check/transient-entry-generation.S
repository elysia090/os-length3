/* A scratch output eventually publishes the accumulator's entry generation.
 * It cannot be closed by copying the accumulator after the destructive SUB.
 * The same lifetime law applies to a stack pointer and an ordinary GPR. */
.intel_syntax noprefix
.global _start
.text
_start:
#if TRANSIENT_ENTRY_CASE == 1
    mov r12, rsp
#define ACC r12
#define COPY r8
#elif TRANSIENT_ENTRY_CASE == 2
#define ACC rsp
#define COPY rdi
#else
#define ACC rsp
#define COPY r8
#endif
    mov r10, ACC
    mov eax, DWORD PTR [rip + count]
    mov COPY, ACC
    lea rax, [rax * 8 + 15]
    shr rax, 4
    shl rax, 4
    sub ACC, rax
    mov eax, DWORD PTR [rip + count]
    mov QWORD PTR [rip + saved], COPY
    setb bl
    cmp COPY, r10
    jne failed
    sub r10, 112
    cmp ACC, r10
    jne failed
    test bl, bl
    jne failed
    mov edi, 42
    jmp exit
failed:
    mov edi, 1
exit:
    mov eax, 60
    syscall
.section .rodata
count:
    .long 13
.bss
.p2align 3
saved:
    .skip 8
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
    .rept 4096
    .byte 0
    .endr

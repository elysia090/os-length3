.text
.globl fxsr
.type fxsr, @function
fxsr:
    cmp $0, %edx
    jne 1f
    fninit
    fld1
    fldz
    movdqu (%rdi), %xmm0
    movdqu 240(%rdi), %xmm15
    fxsave64 (%rsi)
    jmp 5f
1:
    cmp $1, %edx
    jne 2f
    fxrstor64 (%rdi)
    fxsave64 (%rsi)
    jmp 5f
2:
    cmp $2, %edx
    jne 3f
    fxrstor (%rdi)
    fxsave (%rsi)
    jmp 5f
3:
    cmp $3, %edx
    jne 4f
    ldmxcsr (%rdi)
    stmxcsr (%rsi)
    jmp 5f
4:
    cmp $4, %edx
    jne 6f
    fxsave64 (%rsi)
5:
    mov $231, %eax
    xor %edi, %edi
    syscall
6:
    cmp $5, %edx
    jne 7f
    addss %xmm0, %xmm0
    jmp 5b
7:
    cmp $6, %edx
    jne 8f
    fldcw (%rdi)
8:
    fnstcw (%rsi)
    fnstsw 2(%rsi)
    jmp 5b
.size fxsr, .-fxsr
.section .note.GNU-stack,"",@progbits

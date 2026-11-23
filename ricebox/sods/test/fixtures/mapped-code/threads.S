// A parent and child share one address space, with separate CPU contexts.
.global threads
.text
threads:
    mov %rsi, %r12
    movl $111, 96(%r12)
    movl $222, 104(%r12)
    mov $158, %eax
    mov $0x1002, %edi
    lea 96(%r12), %rsi
    syscall
    test %rax, %rax
    jne fail

    mov $45, %eax
    movq %rax, %xmm0
    fld1
    movl $0x1f00, 124(%r12)
    ldmxcsr 124(%r12)
    mov $56, %eax
    mov $0x3d0f00, %edi
    lea 4096(%r12), %rsi
    lea 112(%r12), %rdx
    mov %rdx, %r10
    lea 104(%r12), %r8
    syscall
    test %rax, %rax
    jz child
    js fail

    mov %eax, %edx
    mov $202, %eax
    lea 112(%r12), %rdi
    mov $0x80, %esi
    xor %r10d, %r10d
    syscall
    test %rax, %rax
    jne fail
    cmpl $0, 112(%r12)
    jne fail
    cmpl $111, %fs:0
    jne fail
    movq %xmm0, %rax
    cmp $45, %rax
    jne fail
    fxsave 256(%r12)
    cmpw $0x3fff, 296(%r12)
    jne fail
    stmxcsr 124(%r12)
    cmpl $0x1f00, 124(%r12)
    jne fail
    mov $42, %edi
    jmp done

child:
    cmpl $222, %fs:0
    jne fail
    movq %xmm0, %rax
    cmp $45, %rax
    jne fail
    pxor %xmm0, %xmm0
    fxsave 256(%r12)
    cmpw $0x3fff, 296(%r12)
    jne fail
    fldz
    movl $0x1f80, 124(%r12)
    ldmxcsr 124(%r12)
    xor %edi, %edi
    mov $60, %eax
    syscall
fail:
    mov $2, %edi
done:
    mov $231, %eax
    syscall
    ud2
.section .note.GNU-stack,"",@progbits

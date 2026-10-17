/* A derived end pointer may be reused only after its register publication.
 * GCC's profile pass computes a pointer and a reverse-iteration bound from
 * one runtime count.  An old RBP generation must not seed the bound. */
.data
.balign 8
table:
    .quad 1, 2, 3, 4

.text
.globl _start
.type _start, @function
_start:
    lea table(%rip), %rbx
    mov (%rsp), %eax
    mov %eax, %edx
    test %eax, %eax
    setne %bpl
    jle fail
.globl affine_start
affine_start:
    cltq
    xor %r14d, %r14d
    shl $3, %rax
    /* Keep an exact-source competitor without changing the SSA transfer. */
    nopl (%rax)
    lea (%rbx,%rax), %r12
    lea -8(%rbx,%rax), %r13
    lea -1(%rdx), %eax
    mov %r12, %rbp
    shl $3, %rax
    sub %rax, %r13
    jmp verify
verify:
    cmp %rbx, %r13
    jne fail
    xor %edi, %edi
    jmp finish
fail:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall

.balign 16
.rept 4096
    nop
.endr

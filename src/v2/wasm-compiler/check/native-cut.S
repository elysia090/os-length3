/* Test-only native oracle. RSP reads observe the actual harness stack;
 * writes are forbidden by the test driver. Other GPRs/defined flags are observed. */
.text
.globl native_cut
.type native_cut,@function
native_cut:
    push %rbp
    push %rbx
    push %r12
    push %r13
    push %r14
    push %r15
    push %rdi
    push %rsi
    mov %rdi,%rax
    lea -8(%rsp),%rdx
    mov %rdx,32(%rax)
    pushq 392(%rax)
    popfq
    mov 8(%rax),%rcx
    mov 16(%rax),%rdx
    mov 24(%rax),%rbx
    mov 40(%rax),%rbp
    mov 48(%rax),%rsi
    mov 56(%rax),%rdi
    mov 64(%rax),%r8
    mov 72(%rax),%r9
    mov 80(%rax),%r10
    mov 88(%rax),%r11
    mov 96(%rax),%r12
    mov 104(%rax),%r13
    mov 112(%rax),%r14
    mov 120(%rax),%r15
    mov 0(%rax),%rax
    call *(%rsp)
    pushfq
    push %rax
    push %rdx
    mov 32(%rsp),%rax
    mov %rcx,8(%rax)
    mov %rbx,24(%rax)
    mov %rbp,40(%rax)
    mov %rsi,48(%rax)
    mov %rdi,56(%rax)
    mov %r8,64(%rax)
    mov %r9,72(%rax)
    mov %r10,80(%rax)
    mov %r11,88(%rax)
    mov %r12,96(%rax)
    mov %r13,104(%rax)
    mov %r14,112(%rax)
    mov %r15,120(%rax)
    mov 8(%rsp),%rdx
    mov %rdx,0(%rax)
    mov 0(%rsp),%rdx
    mov %rdx,16(%rax)
    mov 16(%rsp),%rdx
    mov %rdx,392(%rax)
    add $40,%rsp
    pop %r15
    pop %r14
    pop %r13
    pop %r12
    pop %rbx
    pop %rbp
    ret
.size native_cut,.-native_cut
.section .note.GNU-stack,"",@progbits

/* Test-only serial trampoline: guest RSP is genuine. Capturing a POP RSP or
 * RET-immediate result never dereferences that new stack pointer. */
.text
.global native_stack_cut
.type native_stack_cut,@function
native_stack_cut:
    push %rbp
    push %rbx
    push %r12
    push %r13
    push %r14
    push %r15
    mov %rsp,native_stack_host(%rip)
    mov %rsi,native_stack_entry(%rip)
    mov %rdi,%rax
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
    mov 32(%rax),%rsp
    mov 0(%rax),%rax
    jmp *native_stack_entry(%rip)
.size native_stack_cut,.-native_stack_cut
.global native_stack_capture
.type native_stack_capture,@function
native_stack_capture:
    mov %rax,native_stack_result(%rip)
    mov %rcx,native_stack_result+8(%rip)
    mov %rdx,native_stack_result+16(%rip)
    mov %rbx,native_stack_result+24(%rip)
    mov %rsp,native_stack_result+32(%rip)
    mov %rbp,native_stack_result+40(%rip)
    mov %rsi,native_stack_result+48(%rip)
    mov %rdi,native_stack_result+56(%rip)
    mov %r8,native_stack_result+64(%rip)
    mov %r9,native_stack_result+72(%rip)
    mov %r10,native_stack_result+80(%rip)
    mov %r11,native_stack_result+88(%rip)
    mov %r12,native_stack_result+96(%rip)
    mov %r13,native_stack_result+104(%rip)
    mov %r14,native_stack_result+112(%rip)
    mov %r15,native_stack_result+120(%rip)
    mov native_stack_host(%rip),%rsp
    pushfq
    popq native_stack_result+128(%rip)
    cld /* The captured guest DF must not leak into the C oracle caller. */
    pop %r15
    pop %r14
    pop %r13
    pop %r12
    pop %rbx
    pop %rbp
    ret
.size native_stack_capture,.-native_stack_capture
.bss
.align 8
native_stack_host: .quad 0
native_stack_entry: .quad 0
.global native_stack_result
.hidden native_stack_result
native_stack_result: .zero 136
.section .note.GNU-stack,"",@progbits

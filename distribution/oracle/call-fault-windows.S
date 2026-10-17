/* Native Windows observation only. A VEH restores the captured caller stack
 * AFTER recording the original context; no guest compiler or VM is involved. */
.text
.globl call_fault_windows_enter
call_fault_windows_enter:
    push %rbp
    push %rbx
    push %rsi
    push %rdi
    push %r12
    push %r13
    push %r14
    push %r15
    mov %rsp,call_fault_windows_stack(%rip)
    mov %r8,call_fault_windows_entry(%rip)
    push %rdx
    popfq
    mov %rcx,%rax
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
    mov (%rax),%rax
    jmp *call_fault_windows_entry(%rip)
.globl call_fault_windows_resume
call_fault_windows_resume:
    cld
    pop %r15
    pop %r14
    pop %r13
    pop %r12
    pop %rdi
    pop %rsi
    pop %rbx
    pop %rbp
    ret
.bss
.balign 8
.globl call_fault_windows_stack
call_fault_windows_stack: .quad 0
call_fault_windows_entry: .quad 0

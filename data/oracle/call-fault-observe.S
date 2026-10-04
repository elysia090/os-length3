/* Independent native fault observer. No product state, decoder or compiler. */
.text
.global call_fault_enter
.type call_fault_enter,@function
call_fault_enter:
    push %rbp
    push %rbx
    push %r12
    push %r13
    push %r14
    push %r15
    mov %rdx,call_fault_entry(%rip)
    push %rsi
    popfq
    mov %rdi,%rax
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
    jmp *call_fault_entry(%rip)
.size call_fault_enter,.-call_fault_enter
.bss
.balign 8
call_fault_entry: .quad 0
.section .note.GNU-stack,"",@progbits

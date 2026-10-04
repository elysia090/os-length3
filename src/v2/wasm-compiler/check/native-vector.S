/* Test-only FPU envelope; native_stack_cut captures all GPRs/flags. The C
 * signal owner saves/restores the host FPU even on a fault/longjmp. */
.text
.globl native_vector
.type native_vector,@function
native_vector:
    push %rbp
    mov %rsp,%rbp
    sub $16,%rsp
    mov %r8,-8(%rbp)
    fxrstor64 (%rdx)
    fxsave64 (%rcx)
    call native_stack_cut
    mov -8(%rbp),%rax
    fxsave64 (%rax)
    leave
    ret
.size native_vector,.-native_vector
.section .note.GNU-stack,"",@progbits

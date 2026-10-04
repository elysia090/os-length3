.text
.globl native_fxsave
.type native_fxsave,@function
/* C test oracle only. Save the host FPU, install the independent observation
 * image, record logical x87/XMM before and after the actual instruction, and
 * restore the host FPU. native_cut captures guest GPRs/RFLAGS separately. */
native_fxsave:
    push %rbp
    mov %rsp,%rbp
    sub $544,%rsp
    and $-16,%rsp
    mov %r8,512(%rsp)
    fxsave64 (%rsp)
    fxrstor64 (%rdx)
    fxsave64 (%rcx)
    call native_cut
    mov 512(%rsp),%rax
    fxsave64 (%rax)
    fxrstor64 (%rsp)
    leave
    ret
.size native_fxsave,.-native_fxsave
.section .note.GNU-stack,"",@progbits

/* Test-only base envelope. No C/libc runs with the substituted FS base.
 * The signal entry restores both host bases before entering the C observer. */
.text
.globl native_segment_cut
.type native_segment_cut,@function
native_segment_cut:
    push %rbp
    mov %rsp,%rbp
    sub $32,%rsp
    mov %rdi,-8(%rbp)
    mov %rsi,-16(%rbp)
    mov %edx,-24(%rbp)
    mov %rcx,%rsi
    mov $0x1002,%edi
    test %edx,%edx
    jz 1f
    mov $0x1001,%edi
1:  mov $158,%eax
    syscall
    test %rax,%rax
    jnz 3f
    mov -8(%rbp),%rdi
    mov -16(%rbp),%rsi
    call native_cut
    mov native_host_fs(%rip),%rsi
    mov $0x1002,%edi
    cmpl $0,-24(%rbp)
    jz 2f
    mov native_host_gs(%rip),%rsi
    mov $0x1001,%edi
2:  mov $158,%eax
    syscall
3:  leave
    ret
.size native_segment_cut,.-native_segment_cut

.globl native_segment_signal
.type native_segment_signal,@function
native_segment_signal:
    push %rdi
    push %rsi
    push %rdx
    mov native_host_fs(%rip),%rsi
    mov $0x1002,%edi
    mov $158,%eax
    syscall
    mov native_host_gs(%rip),%rsi
    mov $0x1001,%edi
    mov $158,%eax
    syscall
    pop %rdx
    pop %rsi
    pop %rdi
    jmp native_segment_fault
.size native_segment_signal,.-native_segment_signal
.section .note.GNU-stack,"",@progbits

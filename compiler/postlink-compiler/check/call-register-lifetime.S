/* A linked caller may keep a caller-saved register across a local callee
 * whose body preserves it.  A release-wide optimizer cannot erase the copy
 * merely because the public SysV ABI would permit the callee to clobber R8. */
    .section .rodata
value:
    .word 27

    .text
    .globl _start
_start:
    lea value(%rip), %rcx
    mov (%rsp), %rax
    test %rax, %rax
    je failed
    mov %rcx, %r8
    push %rbx
    call preserves_r8
    pop %rbx
    cmpw $27, (%r8)
    jne failed
    mov $60, %eax
    xor %edi, %edi
    syscall
failed:
    mov $60, %eax
    mov $1, %edi
    syscall
preserves_r8:
    ret
dead_padding:
    /* Give the product gate enough unreachable bytes to remove that the
     * ordinary optimized ELF is strictly smaller than the linked input. */
    .rept 4096
    nop
    .endr

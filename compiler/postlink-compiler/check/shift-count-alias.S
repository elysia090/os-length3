/* A variable shift must consume the entry CL, even when its result is later
 * published in RCX. GCC's page bitmap uses this exact dependency shape. */
.text
.globl _start
.type _start, @function
_start:
    mov $3, %edx
    mov $7, %ebp
    mov $5, %ecx
    call shift_mask
    cmp $32, %rcx
    jne fail
    cmp $21, %rdx
    jne fail

    mov $3, %edx
    mov $13, %ecx
    call shift_mask
    cmp $8192, %rcx
    jne fail
    cmp $21, %rdx
    jne fail

    xor %edi, %edi
    jmp finish
fail:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall

.type shift_mask, @function
shift_mask:
    mov $1, %r8d
    imul %rbp, %rdx
    shl %cl, %r8
    mov %r8, %rcx
    ret

/* Keep the post-link product gate's size objective independent from the
 * tested computation. The bytes are unreachable in both programs. */
.balign 16
.rept 4096
    nop
.endr

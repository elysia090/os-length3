/* The call's returned pointer and a zero-parent Boolean have distinct SSA
 * generations of RAX. A later memory barrier still consumes the old pointer. */
.text
.globl _start
.type _start,@function
_start:
    movzbl character(%rip), %r12d
    call probe
    cmpl $0, destination(%rip)
    jne failed
    cmp $1, %eax
    jne failed
    mov $42, %edi
    jmp finish
failed:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall
.size _start,.-_start
.type probe,@function
probe:
    call pointer
    mov %rax, %rcx
    xor %eax, %eax
    cmp $45, %r12b
    sete %al
    movl $0, (%rcx)
    ret
.size probe,.-probe
.type pointer,@function
pointer:
    mov pointer_slot(%rip), %rax
    ret
.size pointer,.-pointer
.data
.p2align 3
pointer_slot:
    .quad destination
destination:
    .long 0xcafebabe
character:
    .byte 45
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.fill 4096,1,0

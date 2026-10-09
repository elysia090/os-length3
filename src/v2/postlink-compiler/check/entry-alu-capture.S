/* A linked ordinary ELF reproduces the same entry-generation law as the
 * physical selector comparison, including publication and relocation. */
.text
.globl _start
.type _start,@function
_start:
    mov $1, %eax
    mov $3, %ebx
    xor %edx, %edx
    call transfer
    cmp $2, %eax
    jne failed
    cmp $2, %rdx
    jne failed
    test %ebx, %ebx
    jne failed
    mov $42, %edi
    jmp finish
failed:
    mov $1, %edi
finish:
    mov $60, %eax
    syscall
.size _start,.-_start
.type transfer,@function
transfer:
    xchg %rax, %rdx
    xchg %eax, %ebx
    sub %edx, %eax
    movslq %eax, %rdx
    ret
.size transfer,.-transfer
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.fill 4096,1,0

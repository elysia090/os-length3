.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    .rept 16
    nop
    .endr
    /* The assembler resolves this local RIP-relative address without an ELF
     * relocation.  Moving the containing block must still move the observed
     * code address and admit it as an indirect-control boundary. */
    lea 1f(%rip), %r10
    jmp *%r10
    ud2
1:
    lea _start(%rip), %rbx
    movabs $_start - 0x80000000, %rax
    movabs $0x80000000, %rcx
    add %rcx, %rax
    cmp %rbx, %rax
    jne 1f
    mov $60, %eax
    xor %edi, %edi
    syscall
1:
    mov $60, %eax
    mov $1, %edi
    syscall
    ud2
.size _start, .-_start

/* Keep the product gate independent from the relocation property: this
 * unreachable linked payload gives the post-link pass a strict size win. */
.section .text.dead,"ax",@progbits
.type dead_payload,@function
dead_payload:
    call _start
    .fill 512, 1, 0xcc
    ret
.size dead_payload, .-dead_payload

.section .debug.padding,"",@progbits
.fill 4096, 1, 0

.section .note.GNU-stack,"",@progbits

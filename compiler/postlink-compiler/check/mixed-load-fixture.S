.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    .rept 16
    nop
    .endr
    push %rbp
    mov %rsp, %rbp
    /* Admit the PF_X datum as a syntactically valid code coordinate without
     * taking that edge at runtime.  A RIP-relative memory load must still
     * address its non-executable section, not the compact code coordinate
     * that happens to share the same source byte. */
    xor %eax, %eax
    test %eax, %eax
    jne result
    mov result(%rip), %edi
    pop %rbp
    mov $60, %eax
    syscall
    ud2
.size _start, .-_start

.section .rodata.result,"a",@progbits
.type result,@object
result:
    .long 42
.size result, .-result

.section .note.fixture,"a",@note
.balign 4
    .long 4
    .long 4
    .long 1
    .asciz "TEST"
    .balign 4
    .long 0x12345678

.section .data.fixture,"aw",@progbits
.quad 0

/* Construction bytes make the ordinary-ELF size gate observable without
 * changing the runtime mapping exercised by this fixture. */
.section .debug.padding,"",@progbits
.space 65536

.section .note.GNU-stack,"",@progbits

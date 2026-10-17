/* A checked switch has an indirect tail call in its default arm. The table
 * still encodes target - table_base, never target - row_address. An unknown
 * tail target must not make relocation silently choose the latter encoding. */
.section .text
.globl _start
.type _start, @function
_start:
    lea .Lobject(%rip), %rdi
    mov $18, %esi
    xor %edx, %edx
    xor %ecx, %ecx
    call choose
    cmp $42, %eax
    jne .Lbad
    lea .Lobject(%rip), %rdi
    mov $17, %esi
    call choose
    cmp $44, %eax
    jne .Lbad
    lea .Lobject(%rip), %rdi
    mov $99, %esi
    call choose
    cmp $44, %eax
    jne .Lbad
    mov $42, %edi
    jmp .Lexit
.Lbad:
    mov $1, %edi
.Lexit:
    mov $60, %eax
    syscall
.size _start, .-_start

.type choose, @function
choose:
    mov %rdi, %r10
    sub $8, %rsp
    mov %rdx, %rdi
    mov %rcx, %rdx
    test %r10, %r10
    je .Lzero
    lea -16(%rsi), %eax
    cmp $3, %eax
    ja .Ldefault
    lea .Ltable(%rip), %rcx
    movslq (%rcx,%rax,4), %rax
    add %rcx, %rax
    jmp *%rax
.Lzero:
    xor %eax, %eax
    add $8, %rsp
    ret
.Lcase40:
    mov $40, %eax
    add $8, %rsp
    ret
.Lcase42:
    mov $42, %eax
    add $8, %rsp
    ret
.Ldefault:
    mov (%r10), %rax
    mov %r10, %rdi
    add $8, %rsp
    jmp *%rax
.size choose, .-choose

.type tail, @function
tail:
    mov $44, %eax
    ret
.size tail, .-tail

.section .rodata
.p2align 2
.Ltable:
#ifdef STALE_RELA_ROWS
    .long .Lcase42 - .Ltable
#else
    .long .Lcase40 - .Ltable
#endif
    .long .Ldefault - .Ltable
#ifdef STALE_RELA_ROWS
    /* The test replaces this linked word after linking, without changing
     * its saved RELA record. Only the final allocated bytes are executed. */
    .long .Lcase40 - .Ltable
#else
    .long .Lcase42 - .Ltable
#endif
    .long .Ldefault - .Ltable
.p2align 3
.Lobject:
    .quad tail
.section .note.GNU-stack,"",@progbits
.section .debug_fixture,"",@progbits
.fill 4096, 1, 0

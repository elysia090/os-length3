.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    nop
    nop
    mov $39, %eax
    xor %edi, %edi
    syscall
    mov %rax, %rdi
    call table_value
    cmp $42, %eax
    jne .Lbad_result
    xor %edi, %edi
    call masked_table_value
    cmp $42, %eax
    jne .Lbad_result
    mov $7, %edi
    call masked_table_value
    cmp $42, %eax
    jne .Lbad_result
    mov $42, %eax
    jmp .Lexit
.Lbad_result:
    xor %eax, %eax
.Lexit:
    mov %eax, %edi
    mov $60, %eax
    syscall
.size _start, .-_start

.type value,@function
.section .text.value,"ax",@progbits
value:
    xor %eax, %eax
    test %rdi, %rdi
    setne %al
    imul $42, %eax, %eax
    ret
.size value, .-value

.type table_value,@function
.section .text.table_value,"ax",@progbits
table_value:
    /* The table base is intentionally hoisted across unrelated work.  GCC
     * emits this shape for format and state-machine dispatchers. */
    lea .Ltable(%rip), %r11
    and $1, %edi
    mov %edi, -4(%rsp)
    mov -4(%rsp), %edx
    movzbl %dl, %r8d
    /* The decoder exposes 0xc0 in sign-extended form.  The finite bound is
     * nevertheless the 8-bit value selected by the compare instruction. */
    cmpb $0xc0, %dl
    ja .Ltable_bad
    /* A normal frame prologue is an identity for the proved index alias. */
    push %rbp
    mov %rsp, %rbp
    sub $16, %rsp
    mov %r11, %rcx
    movslq (%r11,%r8,4), %rax
    mov %rsi, -8(%rbp)
    add %r11, %rax
    jmp *%rax
.Ltable_zero:
    mov $42, %eax
    leave
    ret
.Ltable_one:
    mov $42, %eax
    leave
    ret
    .space 192, 0x90
.Ltable_bad:
    xor %eax, %eax
    ret
.size table_value, .-table_value

.type masked_table_value,@function
.section .text.masked_table_value,"ax",@progbits
masked_table_value:
    lea .Lmasked_table(%rip), %r11
    mov %edi, %eax
    and $7, %eax
    /* Scheduling independent work between the mask and indexed load must
     * preserve the finite dispatch domain for every table row. */
    mov %edi, %r9d
    mov $0, %ecx
    movslq (%r11,%rax,4), %rax
    add %r11, %rax
    jmp *%rax
.Lmasked_value:
    mov $42, %eax
    ret
.size masked_table_value, .-masked_table_value

/* Keep the relocation owner at the full EVEX instruction boundary.  The
 * opcode suffix is also a valid shorter x86 instruction, so a decoder that
 * ignores compound prefixes would create an overlapping entry. */
.type vector_relocation,@function
.section .text.vector_relocation,"ax",@progbits
vector_relocation:
    .byte 0x62, 0xf1, 0xdd, 0x28, 0xdb, 0x25
    .long .Lvector_mask - . - 4
    ret
.size vector_relocation, .-vector_relocation

.type counted_control,@function
.section .text.counted_control,"ax",@progbits
counted_control:
    mov $1, %ecx
.Lcounted:
    nop
    loop .Lcounted
    jrcxz .Lcounted_done
.Lcounted_done:
    ret
.size counted_control, .-counted_control

.section .rodata.fixture,"a",@progbits
.balign 4
.Ltable:
    .long .Ltable_zero - .Ltable
    .long .Ltable_one - .Ltable
    .rept 191
    .long .Ltable_zero - .Ltable
    .endr
.balign 4
.Lmasked_table:
    .rept 8
    .long .Lmasked_value - .Lmasked_table
    .endr
.balign 32
.Lvector_mask:
    .zero 32

/* A code-address construction is itself a linked instruction root even when
 * its containing section is not reachable from a typed function symbol. */
.section .text.detached,"ax",@progbits
detached_code_address:
    lea value(%rip), %rax
    ret

/* Construction relocations in code outside the linked closure have no
 * output field.  In particular, an absolute code address must not be
 * projected through the preceding reachable block. */
.section .text.unreachable,"ax",@progbits
unreachable_absolute_code_address:
    mov $value, %rcx
    ret

.section .note.GNU-stack,"",@progbits

/* A TLS segment may consist only of zero-initialized storage.  Its source
 * p_offset can be beyond the compacted file even though p_filesz is zero. */
.section .tbss,"awT",@nobits
.balign 8
.type tls_zero,@object
tls_zero:
    .zero 16
.size tls_zero, .-tls_zero

/* Construction-only input bytes make the whole-file smaller gate independent
 * of the fixed proof vocabulary in this deliberately tiny executable. */
.section .debug.fixture,"",@progbits
.zero 4096

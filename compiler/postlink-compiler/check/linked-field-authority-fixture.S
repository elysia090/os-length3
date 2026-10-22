.section .text
.globl _start
.type _start, @function
_start:
    .rept 32
    nop
    .endr
    lea linked_rows(%rip), %rbx

    movslq 0(%rbx), %rax
    add %rbx, %rax
    lea target_b(%rip), %rcx
    cmp %rcx, %rax
    jne failed

    movslq 4(%rbx), %rax
    lea 4(%rbx,%rax), %rax
    lea target_a(%rip), %rcx
    cmp %rcx, %rax
    jne failed

    mov $60, %eax
    mov $42, %edi
    syscall
failed:
    mov $60, %eax
    mov $1, %edi
    syscall
.size _start, .-_start

.type target_a, @function
target_a:
    mov $11, %eax
    ret
.size target_a, .-target_a

.type target_b, @function
target_b:
    mov $22, %eax
    ret
.size target_b, .-target_b

/* The linker initially writes A then B.  The test swaps the two resolved
 * fields without changing their construction relocations, exactly as a
 * post-link table sorter does.  The final allocated bytes, not stale RELA
 * history, must remain authoritative. */
.section .linked_field_authority,"a",@progbits
.ascii "PLFIELD-AUTH-v1!"
.globl linked_rows
linked_rows:
    .long target_a - .
    .long target_b - .

.section .text.unreachable,"ax",@progbits
.fill 4096, 1, 0xcc

.section .note.GNU-stack,"",@progbits

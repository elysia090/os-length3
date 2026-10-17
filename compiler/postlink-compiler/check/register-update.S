/* Success/failure preserve the full parent that was not written. */
.text
.global _start
_start:
    movabs $0xfeedcafedeadbeef,%rax
    movabs $0x99887766deadbeef,%rdx
    mov $0x12345678,%ecx
    cmpxchg %ecx,%edx
    jne failure
    mov %rax,%r8
    shr $32,%r8
    mov $0xfeedcafe,%r9d
    cmp %r9,%r8
    jne failure
    cmp $0x12345678,%rdx
    jne failure

    movabs $0xfeedcafe00000001,%rax
    movabs $0x9988776600000002,%rdx
    cmpxchg %ecx,%edx
    je failure
    cmp $2,%rax
    jne failure
    movabs $0x9988776600000002,%r8
    cmp %r8,%rdx
    jne failure

    movabs $0x123456789abc1204,%rax
    mov $0x34,%cl
    cmpxchg %cl,%ah
    je failure
    movabs $0x123456789abc1212,%r8
    cmp %r8,%rax
    jne failure
    cmpxchg %cl,%ah
    jne failure
    movabs $0x123456789abc3412,%r8
    cmp %r8,%rax
    jne failure
    xadd %al,%ah
    movabs $0x123456789abc4634,%r8
    cmp %r8,%rax
    jne failure
    xor %edi,%edi
    jmp exit
failure:
    mov $1,%edi
exit:
    mov $60,%eax
    syscall
.section .note.GNU-stack,"",@progbits

.type dispatch_before_entry,@function
.section .text,"ax",@progbits
dispatch_before_entry:
    /* Static function extents are compiler evidence, not execution roots.
     * This function is linked before the process entry and must still own its
     * table consumer without being published as another root. */
    cmp $14, %edi
    ja .Lbefore_bad
    lea .Lbefore_table(%rip), %rcx
    movslq (%rcx,%rdi,4), %rax
    add %rcx, %rax
    jmp *%rax
.Lbefore_value:
    mov $42, %eax
    ret
.Lbefore_bad:
    mov $1, %eax
    ret
.size dispatch_before_entry, .-dispatch_before_entry

.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    xor %edi, %edi
    xor %esi, %esi
    call dispatch
    mov %eax, %edi
    mov $60, %eax
    syscall
.size _start, .-_start

.type dispatch,@function
.section .text.dispatch,"ax",@progbits
dispatch:
    /* Both bounds dominate the table load.  The side exit preserves the
     * index on the fallthrough path that reaches the dispatch. */
    cmp $99, %edi
    ja .Lbad
    test %esi, %esi
    jne .Lbad
    cmp $14, %edi
    ja .Lbad
    lea .Ltable(%rip), %rcx
    movslq (%rcx,%rdi,4), %rax
    add %rcx, %rax
    test %esi, %esi
    jmp *%rax
.Lvalue:
    mov $42, %eax
    ret
.Lbad:
    mov $1, %eax
    ret
.size dispatch, .-dispatch

.type dispatch_taken,@function
.section .text.dispatch_taken,"ax",@progbits
dispatch_taken:
    /* The accepted finite range may be the taken arm instead of the lexical
     * fallthrough arm. */
    cmp $14, %edi
    jbe .Ltaken
    mov $1, %eax
    ret
.Ltaken:
    lea .Ltaken_table(%rip), %rcx
    movslq (%rcx,%rdi,4), %rax
    add %rcx, %rax
    jmp *%rax
.Ltaken_value:
    mov $42, %eax
    ret
.size dispatch_taken, .-dispatch_taken

.type dispatch_remote,@function
.section .text.dispatch_remote,"ax",@progbits
dispatch_remote:
    /* The finite accepted edge is a control-flow fact, not a lexical-window
     * fact.  Keep its consumer beyond the former thirty-byte look-behind. */
    cmp $14, %edi
    jbe .Lremote
    mov $1, %eax
    ret
    .rept 64
    nop
    .endr
.Lremote:
    lea .Lremote_table(%rip), %rcx
    movslq (%rcx,%rdi,4), %rax
    add %rcx, %rax
    jmp *%rax
.Lremote_value:
    mov $42, %eax
    ret
.size dispatch_remote, .-dispatch_remote

.type dispatch_hoisted,@function
.section .text.dispatch_hoisted,"ax",@progbits
dispatch_hoisted:
    /* A loop-invariant base may be hoisted into a callee-saved register well
     * before the bounded consumer.  The index can be copied after the cut. */
    lea .Lhoisted_table(%rip), %r14
    nop
    nop
    cmp $14, %edi
    ja .Lhoisted_bad
    mov %edi, %edx
    movslq (%r14,%rdx,4), %rax
    add %r14, %rax
    jmp *%rax
.Lhoisted_value:
    mov $42, %eax
    ret
.Lhoisted_bad:
    mov $1, %eax
    ret
.size dispatch_hoisted, .-dispatch_hoisted

.type dispatch_byte_bound,@function
.section .text.dispatch_byte_bound,"ax",@progbits
dispatch_byte_bound:
    /* The dispatch coordinate is a quotient of the compared byte. */
    movzbl 1(%rsi), %ecx
    mov %ecx, %eax
    shr $5, %al
    cmp $0xdf, %cl
    mov %cl, -1(%rsp)
    ja .Lbyte_bad
    lea .Lbyte_table(%rip), %rdx
    movzbl %al, %eax
    movslq (%rdx,%rax,4), %rax
    add %rdx, %rax
    jmp *%rax
.Lbyte_value:
    mov $42, %eax
    ret
.Lbyte_bad:
    mov $1, %eax
    ret
.size dispatch_byte_bound, .-dispatch_byte_bound

.type dispatch_nonnegative_sar,@function
.section .text.dispatch_nonnegative_sar,"ax",@progbits
dispatch_nonnegative_sar:
    movzwl 2(%rsi), %edx
    mov %edx, %eax
    sar $7, %ax
    cmp $0x67f, %dx
    ja .Lsar_bad
    lea .Lsar_table(%rip), %rcx
    movzwl %ax, %eax
    movslq (%rcx,%rax,4), %rax
    add %rcx, %rax
    jmp *%rax
.Lsar_value:
    mov $42, %eax
    ret
.Lsar_bad:
    mov $1, %eax
    ret
.size dispatch_nonnegative_sar, .-dispatch_nonnegative_sar

.type dispatch_spilled_bound,@function
.section .text.dispatch_spilled_bound,"ax",@progbits
dispatch_spilled_bound:
    /* The compare and dispatch consume two physical stack spellings of the
     * same SSA value.  The second is the zero-extended first value, so the
     * 22-row bound survives store/load substitution. */
    mov %edi, %edx
    mov %dl, -1(%rsp)
    movzbl %dl, %edx
    mov %rdx, -16(%rsp)
    xor %edx, %edx
    cmpb $21, -1(%rsp)
    ja .Lspill_bad
    mov -16(%rsp), %rdx
    lea .Lspill_table(%rip), %rcx
    movslq (%rcx,%rdx,4), %rax
    add %rcx, %rax
    jmp *%rax
.Lspill_value:
    mov $42, %eax
    ret
.Lspill_bad:
    mov $1, %eax
    ret
.size dispatch_spilled_bound, .-dispatch_spilled_bound

.type dispatch_rip_cell_bound,@function
.section .text.dispatch_rip_cell_bound,"ax",@progbits
dispatch_rip_cell_bound:
    /* The compare and reload observe one absolute cell.  Their encoded
     * RIP-relative displacements differ, so equality must be proved from the
     * effective coordinate rather than from the operand spelling. */
    cmpl $5, .Lrip_cell(%rip)
    ja .Lrip_cell_bad
    mov .Lrip_cell(%rip), %eax
    lea .Lrip_cell_table(%rip), %rdx
    movslq (%rdx,%rax,4), %rax
    add %rdx, %rax
    jmp *%rax
.Lrip_cell_value:
    mov $42, %eax
    ret
.Lrip_cell_bad:
    mov $1, %eax
    ret
.size dispatch_rip_cell_bound, .-dispatch_rip_cell_bound

.type dispatch_relational_slot,@function
.section .text.dispatch_relational_slot,"ax",@progbits
dispatch_relational_slot:
    /* The compared frame cell and the table index are distinct physical
     * spellings of one entry value.  No reload exists near the consumer: the
     * equality is a backward relational cut through both reaching stores. */
    push %rbp
    mov %rsp, %rbp
    push %r13
    mov %edi, -4(%rbp)
    mov %edi, %r13d
    test %esi, %esi
    jne .Lrelation_bad
    .rept 64
    nop
    .endr
    cmpl $5, -4(%rbp)
    ja .Lrelation_bad
    lea .Lrelation_table(%rip), %rdx
    movslq (%rdx,%r13,4), %rax
    add %rdx, %rax
    jmp *%rax
.Lrelation_value:
    pop %r13
    leave
    mov $42, %eax
    ret
.Lrelation_bad:
    pop %r13
    leave
    mov $1, %eax
    ret
.size dispatch_relational_slot, .-dispatch_relational_slot

.type dispatch_cfg_spill,@function
.section .text.dispatch_cfg_spill,"ax",@progbits
dispatch_cfg_spill:
    /* The finite state is constructed by remote CFG arms and joined through
     * one private frame slot.  There is deliberately no local CMP or mask at
     * the consumer: recognizing this table requires the whole-function
     * two-coordinate range proof. */
    push %rbp
    mov %rsp, %rbp
    test %edi, %edi
    je .Lcfg_zero
    mov $35, %ecx
    jmp .Lcfg_join
.Lcfg_zero:
    xor %ecx, %ecx
.Lcfg_join:
    mov %ecx, -4(%rbp)
    xor %ecx, %ecx
    mov -4(%rbp), %ecx
    test %esi, %esi
    jne .Lcfg_bad
    lea .Lcfg_table(%rip), %rdx
    movslq (%rdx,%rcx,4), %rax
    add %rdx, %rax
    jmp *%rax
.Lcfg_value:
    leave
    mov $42, %eax
    ret
.Lcfg_bad:
    leave
    mov $1, %eax
    ret
.size dispatch_cfg_spill, .-dispatch_cfg_spill

.section .rodata.table,"a",@progbits
.balign 4
.Ltable:
    .rept 15
    .long .Lvalue - .Ltable
    .endr
.balign 4
.Ltaken_table:
    .rept 15
    .long .Ltaken_value - .Ltaken_table
    .endr
.balign 4
.Lremote_table:
    .rept 15
    .long .Lremote_value - .Lremote_table
    .endr
.balign 4
.Lhoisted_table:
    .rept 15
    .long .Lhoisted_value - .Lhoisted_table
    .endr
.balign 4
.Lbefore_table:
    .rept 15
    .long .Lbefore_value - .Lbefore_table
    .endr
.balign 4
.Lbyte_table:
    .rept 7
    .long .Lbyte_value - .Lbyte_table
    .endr
.balign 4
.Lsar_table:
    .rept 13
    .long .Lsar_value - .Lsar_table
    .endr
.balign 4
.Lspill_table:
    .rept 22
    .long .Lspill_value - .Lspill_table
    .endr
.balign 4
.Lrip_cell_table:
    .rept 6
    .long .Lrip_cell_value - .Lrip_cell_table
    .endr
.balign 4
.Lrelation_table:
    .rept 6
    .long .Lrelation_value - .Lrelation_table
    .endr
.balign 4
.Lcfg_table:
    .rept 36
    .long .Lcfg_value - .Lcfg_table
    .endr

.section .data.rip_cell,"aw",@progbits
.balign 4
.Lrip_cell:
    .long 0

.section .note.GNU-stack,"",@progbits

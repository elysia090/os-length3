.global _start
.type _start,@function
.section .text.start,"ax",@progbits
_start:
    call direct_target
    mov $address_notype_target, %rax
    mov $60, %eax
    xor %edi, %edi
    syscall
.size _start, .-_start

.type direct_target,@function
.section .text.direct,"ax",@progbits
direct_target:
    ret
.size direct_target, .-direct_target

.type address_target,@function
.section .text.address,"ax",@progbits
address_target:
    ret
.size address_target, .-address_target

/* Assembly and hardware entry points commonly have STT_NOTYPE even though
 * their absolute address is materialized by reachable code. */
.global address_notype_target
.section .text.address_notype,"ax",@progbits
address_notype_target:
    ret

.type pc_relative_target,@function
.section .text.pc_relative,"ax",@progbits
pc_relative_target:
    ret
.size pc_relative_target, .-pc_relative_target

.type debug_only_target,@function
.section .text.debug_only,"ax",@progbits
debug_only_target:
    ret
.size debug_only_target, .-debug_only_target

/* This allocated scalar can be loaded and compared by ordinary x86.  Its
 * target therefore belongs to the injective address-value domain. */
.section .rodata.address,"a",@progbits
.quad address_target

/* A raw PC-relative word is not an address without the consumer-selected
 * base.  With no reachable consumer this record must not invent an execution
 * root; recognized tables and decoded address slices cover the live cases. */
.section .rodata.pc_relative,"a",@progbits
.long pc_relative_target - .

/* A construction-only debug relocation is not mapped into the running
 * process and must not create either a closure root or an address value. */
.section .debug.address,"",@progbits
.quad debug_only_target

.section .note.GNU-stack,"",@progbits

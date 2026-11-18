/* The same static ELF checks stable positive task identity and non-writing
 * registration natively and in the selected one-guest-task caller. */
.global _start
.text
_start:
 mov $218,%eax
 lea old(%rip),%rdi
 syscall
 test %rax,%rax
 jle bad
 mov %rax,%r12
 cmpl $0x10203040,old(%rip)
 jne bad
 mov $218,%eax
 mov $-1,%rdi
 syscall
 cmp %r12,%rax
 jne bad
 mov $218,%eax
 xor %edi,%edi
 syscall
 cmp %r12,%rax
 jne bad
 mov $218,%eax
 lea current(%rip),%rdi
 syscall
 cmp %r12,%rax
 jne bad
 cmpl $0x10203040,old(%rip)
 jne bad
 cmpl $0x50607080,current(%rip)
 jne bad
#ifndef SODS_TASK_NO_OUTPUT
 mov %r12,reported_tid(%rip)
 mov $1,%eax
 mov $1,%edi
 lea record(%rip),%rsi
 mov $16,%edx
 syscall
 cmp $16,%rax
 jne bad
#endif
 mov $231,%eax
 mov $279,%edi
 syscall
 ud2
bad:
 mov $60,%eax
 mov $91,%edi
 syscall
 ud2
.data
.align 8
record: .ascii "tid-ok!\n"
reported_tid: .quad 0
old: .long 0x10203040
current: .long 0x50607080
.section .note.GNU-stack,"",@progbits

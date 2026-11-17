/* Only defined x86 flags: call/ret themselves do not modify them.
 * CASE: 0 empty callee, 1 new CMP output, 2 INC preserves CF, 3 ADC reads CF.
 * CASE 10..14: redirected pure returns, nesting, read-only and mixed callees.
 * CASE 9: 450 recursive calls cross the depth-unwind boundary.
 * CASE 4..8: AF preserved, ADD output, INC partial, ADC input, POPFQ.
 * INDIRECT selects a data-loaded target so initial translation needs more(). */
.global _start
.section .text
_start:
 mov target(%rip),%r11
#if CASE == 10 || CASE == 12 || CASE == 14
 /* Keep alternate in this caller's discovered CFG, but do not take it first. */
 mov $0,%r15d
 test %r15d,%r15d
 jnz alternate
#elif CASE == 11
 mov $0,%r15d
 test %r15d,%r15d
 jnz externalcall
#endif
#if CASE == 0
 mov $1,%ebx
 cmp %rbx,%rbx
#elif CASE == 1
 mov $1,%ebx
 clc
#elif CASE == 2
 mov $-1,%rax
 stc
#elif CASE == 3
 mov $10,%eax
 stc
#elif CASE == 4
 mov $15,%eax
 add $1,%eax
#elif CASE == 5
 mov $15,%eax
#elif CASE == 6 || CASE == 7
 mov $15,%eax
 stc
#elif CASE == 8
 pushq $0x12
 popfq
#elif CASE == 9
 mov $0,%r8
 mov $450,%ecx
 mov $15,%eax
 stc
#elif CASE >= 10 && CASE <= 14
 mov $15,%eax
#if CASE == 14
 call normal
#else
 add $1,%eax
#endif
 stc
#endif
#ifdef INDIRECT
 call *%r11
#else
 call callee
#endif
#if CASE == 10 || CASE == 11 || CASE == 12 || CASE == 14
 jmp bad
#endif
alternate:
#if CASE == 0
 jne bad
#elif CASE == 1
 jnc bad
 jz bad
#elif CASE == 2
 jnc bad
 jnz bad
 cmp $0,%rax
 jne bad
#elif CASE == 3
 jc bad
 cmp $11,%rax
 jne bad
#elif CASE >= 4 && CASE <= 14
 /* Capture flags before test/cmp modifies them. All cases require AF=1. */
 pushfq
 pop %rdx
 test $0x10,%edx
 jz bad
#if CASE == 6 || CASE >= 9
 test $1,%edx
 jz bad
#elif CASE == 7
 test $1,%edx
 jnz bad
#endif
#if CASE != 8
 cmp $16,%eax
 jne bad
#endif
#endif
#if CASE == 9
 cmp $450,%r8
 jne bad
#endif
 xor %edi,%edi
 jmp finish
bad:
 mov $1,%edi
finish:
 mov $60,%eax
 syscall
 ud2
#if CASE == 11
externalcall:
 call external_target
 jmp bad
external_target:
 jmp alternate
#endif
#if CASE == 14
normal:
 add $1,%eax
 ret
#endif
callee:
#if CASE == 1
 cmp $2,%rbx
#elif CASE == 2
 inc %rax
#elif CASE == 3
 adc $0,%rax
#elif CASE == 5
 add $1,%eax
#elif CASE == 6
 inc %eax
#elif CASE == 7
 adc $0,%eax
#elif CASE == 9
 lea 1(%r8),%r8
 dec %rcx
 jz base
 call callee
 /* Consume returned flags in each frame, preventing call/ret tail lowering. */
 pushfq
 pop %rdx
 ret
base:
 stc
 inc %eax
#elif CASE == 10 || CASE == 14
 lea alternate(%rip),%rdx
 mov %rdx,(%rsp)
#elif CASE == 11
 lea external_target(%rip),%rdx
 mov %rdx,(%rsp)
#elif CASE == 12
 call nested
 ret
nested:
 /* Change middle's return, not this leaf's immediate normal return. */
 lea alternate(%rip),%rdx
 mov %rdx,8(%rsp)
#elif CASE == 13
 pushfq
 pop %rdx
#endif
 ret
.section .data
target: .quad callee
.section .note.GNU-stack,"",@progbits

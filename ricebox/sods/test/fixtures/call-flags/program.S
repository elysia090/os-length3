/* Only defined x86 flags: call/ret themselves do not modify them.
 * CASE: 0 empty callee, 1 new CMP output, 2 INC preserves CF, 3 ADC reads CF.
 * CASE 10..14: redirected pure returns, nesting, read-only and mixed callees.
 * CASE 15..20: normal-return partial reload, zero shift, CFG join, next call and return.
 * CASE 21..24: callee-side partial producer, zero shift and both incoming CFG paths.
 * CASE 25..26: full output and incoming state across guest-redirected returns.
 * CASE 27..28: deferred CMP branches to external flag consumers, fall and taken.
 * CASE 9: 450 recursive calls cross the depth-unwind boundary.
 * CASE 4..8: AF preserved, ADD output, INC partial, ADC input, POPFQ.
 * INDIRECT selects a data-loaded target so initial translation needs more(). */
.global _start
.section .text
_start:
 mov target(%rip),%r11
#if CASE == 10 || CASE == 12 || CASE == 14 || CASE == 25 || CASE == 26
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
#elif CASE == 15 || CASE == 19
 mov $10,%eax
#elif CASE == 16
 mov $0,%ecx
 mov $7,%ebx
#elif CASE == 17 || CASE == 18
 mov $(CASE - 17),%ecx
 mov $1,%ebx
#elif CASE == 21
 mov $-1,%eax
 mov $0,%ebx
 cmp $1,%ebx
#elif CASE == 22 || CASE == 23 || CASE == 24 || CASE == 26
 mov $1,%ebx
 mov $(CASE - 23),%ecx
 mov $0x7fffffff,%eax
 add $1,%eax
 stc
#elif CASE == 25
 mov $1,%ebx
 cmp %ebx,%ebx
#elif CASE == 27 || CASE == 28
 mov $(16 * (CASE - 27)),%ebx
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
#if CASE == 10 || CASE == 11 || CASE == 12 || CASE == 14 || CASE == 25 || CASE == 26
 jmp bad
#endif
alternate:
#if CASE >= 21 && CASE <= 26
 /* Every captured bit is processor-defined: CF/PF/AF/ZF/SF/OF. INC produces
  * 0x55, 1-2 produces 0x95, and 0x7fffffff+1 followed by STC produces 0x895. */
 pushfq
 pop %rdx
 and $0x8d5,%edx
#if CASE == 21
 cmp $0x55,%edx
#elif CASE == 23
 cmp $0x95,%edx
#else
 cmp $0x895,%edx
#endif
 jne bad
#if CASE == 21
 cmp $0,%eax
 jne bad
#elif CASE == 22
 cmp $1,%ebx
 jne bad
#endif
#elif CASE == 27 || CASE == 28
 /* The external successor captured the deferred comparison before returning. */
 and $0x8d5,%r12d
#if CASE == 27
 cmp $0x95,%r12d
#else
 cmp $0x14,%r12d
#endif
 jne bad
#elif CASE == 15
 /* INC must retain the CF published by the callee; ADC consumes that CF. */
 inc %eax
 adc $0,%eax
 cmp $12,%eax
 jne bad
#elif CASE == 16
 /* CL=0 preserves all defined arithmetic flags, including AF. */
 shl %cl,%ebx
 pushfq
 pop %rdx
 and $0x8d5,%edx
 cmp $0x11,%edx
 jne bad
 cmp $7,%ebx
 jne bad
#elif CASE == 17 || CASE == 18
 /* JRCXZ selects a path without destroying the returned flags. Only one
  * incoming edge to the join kills them with a full CMP producer. */
 jrcxz kill_flags
 jmp joined_flags
kill_flags:
 cmp $2,%ebx
joined_flags:
 jnc bad
#elif CASE == 19
 /* No producer between two calls: second must receive first's output CF. */
 call consume_carry
 cmp $11,%eax
 jne bad
#elif CASE == 20
 jnc bad
#elif CASE == 0
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
#if CASE == 19
consume_carry:
 adc $0,%eax
 ret
#endif
callee:
#if CASE == 21
 /* INC defines every arithmetic flag except the incoming CF. */
 inc %eax
#elif CASE == 22
 /* The runtime count is zero; no arithmetic flag is replaced. */
 mov $0,%ecx
 shl %cl,%ebx
#elif CASE == 23 || CASE == 24
 /* One path kills incoming flags, the other reaches the join unchanged. */
 jrcxz callee_kill_flags
 jmp callee_joined_flags
callee_kill_flags:
 cmp $2,%ebx
callee_joined_flags:
#elif CASE == 25
 /* No incoming arithmetic state is needed, but a redirected return must
  * publish all of this full producer's output, not its normal successor's. */
 mov $0x7fffffff,%eax
 add $1,%eax
 stc
 lea alternate(%rip),%rdx
 mov %rdx,(%rsp)
#elif CASE == 26
 /* This middle callee is nontransparent because of the later CMP. The nested
  * call must nevertheless keep ALL incoming flags live: its leaf can bypass
  * that CMP by returning straight to the outer alternate. */
 call incoming_redirector
 cmp %eax,%eax
 ret
incoming_redirector:
 /* Rewrite this leaf's immediate return, not the middle frame's outer return.
  * LEA/MOV/RET make the leaf flag-transparent. */
 lea alternate(%rip),%rdx
 mov %rdx,(%rsp)
#elif CASE == 27 || CASE == 28
 /* Explicit function boundaries make BOTH successors external. JA compares
  * deferred operands directly; on CASE 27 its conditional tail/save is skipped.
  * The fall-side save must still materialize the pending CMP result itself. */
 cmp $1,%ebx
 ja external_taken_flags
.type external_fall_flags,@function
external_fall_flags:
 pushfq
 pop %r12
 ret
.type external_taken_flags,@function
external_taken_flags:
 pushfq
 pop %r12
#elif CASE == 15 || CASE == 17 || CASE == 18 || CASE == 19
 stc
#elif CASE == 16
 mov $15,%eax
 add $1,%eax
 stc
#elif CASE == 20
 /* The caller of leaf returns immediately, with no local flag consumer. */
 call publish_carry
 ret
publish_carry:
 stc
#elif CASE == 1
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

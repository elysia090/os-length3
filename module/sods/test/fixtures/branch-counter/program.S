/* Counter branches do not modify RCX or CF/PF/AF/ZF/SF/OF.
 * CASE 0: JRCXZ zero; 1: nonzero; 2: upper-32-only nonzero.
 * CASE 3: JECXZ sees ECX zero despite upper RCX; 4: ECX nonzero.
 * CASE 5/6: CMP/TEST adjacent, flags observed; 7/8: flags dead.
 * CASE 9: operand-size prefix must not narrow JRCXZ.
 * LOOP/LOOPE/LOOPNE are deliberately not covered by these counter branches. */
.global _start
.section .text
_start:
#if CASE == 0
 mov $0,%rcx
#elif CASE == 1 || CASE == 5 || CASE == 7
 mov $1,%rcx
#elif CASE == 2 || CASE == 3 || CASE == 6 || CASE == 8 || CASE == 9
 mov $0x100000000,%rcx
#elif CASE == 4
 mov $0x100000001,%rcx
#endif
 mov %rcx,%rbx
 /* Test both all-set and all-clear arithmetic flags; reserved bit1 stays set. */
#ifdef CLEAR_FLAGS
 pushq $2
#else
 pushq $0x8d7
#endif
 popfq
#if CASE == 5 || CASE == 7
 mov $0,%eax
 cmp $0,%eax
#elif CASE == 6 || CASE == 8
 mov $1,%eax
 test %eax,%eax
#endif
#if CASE == 3 || CASE == 4 || CASE == 6 || CASE == 8
 jecxz taken
#else
#if CASE == 9
 .byte 0x66
#endif
 jrcxz taken
#endif
#if CASE == 0 || CASE == 3 || CASE == 6 || CASE == 8
 jmp bad
#else
 jmp verify
#endif
taken:
#if CASE == 0 || CASE == 3 || CASE == 6 || CASE == 8
 jmp verify
#else
 jmp bad
#endif
verify:
#if CASE != 7 && CASE != 8
 pushfq
 pop %rdx
#if CASE == 5
 and $0x8d5,%edx
 cmp $0x44,%edx
#elif CASE == 6
 /* TEST leaves AF undefined; assert only its defined arithmetic flags. */
 and $0x8c5,%edx
 cmp $0,%edx
#else
 and $0x8d5,%edx
#ifdef CLEAR_FLAGS
 cmp $0,%edx
#else
 cmp $0x8d5,%edx
#endif
#endif
 jne bad
#endif
 cmp %rbx,%rcx
 jne bad
 mov $0,%edi
 jmp finish
bad:
 mov $1,%edi
finish:
 mov $60,%eax
 syscall
 ud2
.section .note.GNU-stack,"",@progbits

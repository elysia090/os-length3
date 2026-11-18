/* Same raw-syscall ELF under native Linux and the actual --managed CLI.
 * Open argv[0], retain independent OFDs, use a directory FD, and close/reuse.
 * No libc, new root API, host path assertions or synthetic syscall runner. */
.global _start
.text
.macro want value
 cmp $\value,%rax
 jne bad
.endm
.macro nonnegative
 test %rax,%rax
 js bad
.endm
.macro cwd_syscall
#ifdef SODS_OPEN2
 mov $2,%eax
 mov %rsi,%rdi
 mov %rdx,%rsi
 mov %r10,%rdx
#endif
 syscall
.endm
.macro send_resident_byte
 mov $40,%eax
 mov $2,%edi
 mov %r15d,%esi
 xor %edx,%edx
 mov $1,%r10d
 syscall
 want 1
.endm
_start:
 mov 8(%rsp),%r12
 mov $257,%eax
 mov $-100,%edi
 mov %r12,%rsi
 mov $0x80000,%edx
 xor %r10d,%r10d
 cwd_syscall
 nonnegative
 mov %rax,%r15
#ifdef SODS_CAPTURE_COLD_SOURCE
 send_resident_byte
 mov %r15,%rax
#endif
 mov %rax,%rdi
 xor %eax,%eax
 lea buffer(%rip),%rsi
 mov $4,%edx
 syscall
 want 4
 cmpl $0x464c457f,buffer(%rip)
 jne bad
#if defined SODS_CAPTURE_READY_ONLY
 send_resident_byte
#elif !defined SODS_OPEN_NO_OUTPUT
 mov $1,%eax
 mov $1,%edi
 lea buffer(%rip),%rsi
#ifdef SODS_CAPTURE_WIDE_OUTPUT
 mov $5,%edx
 syscall
 want 5
#else
 mov $4,%edx
 syscall
 want 4
#endif
#if defined SODS_CAPTURE_READY_SOURCE
 /* The normal read already loaded this canonical file. Q is still full. */
 send_resident_byte
#elif defined SODS_OPEN_SECOND_OUTPUT
 /* This overflows the private Q=4 result profile if no receiver drains.
  * A refusal must not retract the already accepted ELF header. */
 mov $1,%eax
 mov $2,%edi
 lea buffer(%rip),%rsi
 mov $1,%edx
 syscall
 want 1
#endif
#endif
 /* A separate open begins at offset zero, not the first OFD's offset four. */
 mov $257,%eax
 mov $-100,%edi
 mov %r12,%rsi
 xor %edx,%edx
 cwd_syscall
 nonnegative
 mov %rax,%rbx
 mov %rax,%rdi
 xor %eax,%eax
 lea buffer(%rip),%rsi
 mov $4,%edx
 syscall
 want 4
 cmpl $0x464c457f,buffer(%rip)
 jne bad
 xor %eax,%eax
 mov %r15,%rdi
 lea buffer(%rip),%rsi
 mov $1,%edx
 syscall
 want 1
#if defined SODS_CAPTURE_READY_SOURCE || defined SODS_CAPTURE_READY_ONLY
 cmpb $1,buffer(%rip) /* sendfile advanced the original alias from offset 4 */
#else
 cmpb $2,buffer(%rip)
#endif
 jne bad
 mov $3,%eax
 mov %r15,%rdi
 syscall
 want 0
 xor %eax,%eax
 mov %r15,%rdi
 lea buffer(%rip),%rsi
 mov $1,%edx
 syscall
 want -9
 /* High flag bits are int-ABI truncation, not unsupported low flags. */
 mov $257,%eax
 mov $-100,%edi
 mov %r12,%rsi
 movabs $0x100088100,%rdx
 cwd_syscall
 cmp %r15,%rax
 jne bad
 mov %rax,%rdi
 xor %eax,%eax
 mov $-1,%rsi
 xor %edx,%edx
 syscall
 want -14
 xor %eax,%eax
 mov %r15,%rdi
 xor %esi,%esi
 xor %edx,%edx
 syscall
 want 0
 mov $3,%eax
 mov %r15,%rdi
 syscall
 want 0
 mov $3,%eax
 mov %rbx,%rdi
 syscall
 want 0
#ifdef SODS_OPEN2
 /* Caller gives the same ../bin/program.elf spelling in isomorphic native and
  * guest roots, each with cwd /root. This checks open(2)'s captured cwd route. */
 mov $2,%eax
 mov 16(%rsp),%rdi
 xor %esi,%esi
 xor %edx,%edx
 syscall
 nonnegative
 mov %rax,%rdi
 mov %rax,%r13
 xor %eax,%eax
 lea buffer(%rip),%rsi
 mov $4,%edx
 syscall
 want 4
 cmpl $0x464c457f,buffer(%rip)
 jne bad
 mov $3,%eax
 mov %r13,%rdi
 syscall
 want 0
#endif
 /* Capture errors precede a bad dirfd; absolute paths ignore it. */
 mov $257,%eax
 mov $999,%edi
 lea empty(%rip),%rsi
 xor %edx,%edx
 syscall
 want -2
 mov $257,%eax
 mov $999,%edi
 xor %esi,%esi
 syscall
 want -14
 mov $257,%eax
 mov $999,%edi
 lea missing(%rip),%rsi
 syscall
 want -9
 mov $257,%eax
 mov $999,%edi
 mov %r12,%rsi
 syscall
 nonnegative
 mov %rax,%rdi
 mov $3,%eax
 syscall
 want 0
 /* Split our actual argv[0] into a parent path and a basename in place. */
 mov %r12,%rsi
 xor %r13d,%r13d
scan:
 mov (%rsi),%al
 test %al,%al
 jz parent
 cmp $47,%al
 jne next
 mov %rsi,%r13
 lea 1(%rsi),%r14
next:
 inc %rsi
 jmp scan
parent:
 test %r13,%r13
 jz bad
 movb $0,(%r13)
 mov $257,%eax
 mov $-100,%edi
 mov %r12,%rsi
 mov $0x10000,%edx
 cwd_syscall
 nonnegative
 mov %rax,%rbx
 xor %eax,%eax
 mov %rbx,%rdi
 xor %esi,%esi
 xor %edx,%edx
 syscall
 want -21
 xor %eax,%eax
 mov %rbx,%rdi
 mov $-1,%rsi
 xor %edx,%edx
 syscall
 want -14
 mov $257,%eax
 mov %rbx,%rdi
 movabs $0x100000000,%rax
 or %rax,%rdi
 mov $257,%eax
 mov %r14,%rsi
 xor %edx,%edx
 syscall
 nonnegative
 mov %rax,%r8
 movb $47,(%r13)
 mov $3,%eax
 mov %rbx,%rdi
 syscall
 want 0
 xor %eax,%eax
 mov %r8,%rdi
 lea buffer(%rip),%rsi
 mov $4,%edx
 syscall
 want 4
 cmpl $0x464c457f,buffer(%rip)
 jne bad
 xor %eax,%eax
 mov %r8,%rdi
 lea buffer(%rip),%rsi
 mov $1,%edx
 syscall
 want 1
 cmpb $2,buffer(%rip)
 jne bad
 mov $3,%eax
 mov %r8,%rdi
 syscall
 want 0
 mov $3,%eax
 mov $999,%edi
 syscall
 want -9
 xor %edi,%edi
 jmp finish
bad:
 mov $1,%edi
finish:
 mov $60,%eax
 syscall
 ud2
.section .rodata
empty: .byte 0
missing: .asciz "__sods_missing__"
.bss
.balign 16
buffer: .skip 16
.section .note.GNU-stack,"",@progbits

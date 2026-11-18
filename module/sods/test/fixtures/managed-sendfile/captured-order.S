/* Actual x86-64 source for the marker-rejected mixed capture fixture.
 * Verify the real Rust-built stack, then stdout write A and sendfile B,
 * followed by stderr write C. Startup must deliberately join both lanes.
 * No operation here expects a physical descriptor or external sink. */
.global _start
.section .text
_start:
  cmpq $1, (%rsp)
  jne bad
  mov 8(%rsp), %rax
#ifdef SODS_OWNED_STDOUT_ONLY
  cmpb $47, (%rax)
  jne bad
  /* No inherited stdin or stderr even when the host process has both. */
  xor %eax, %eax
  xor %edi, %edi
  lea first(%rip), %rsi
  mov $1, %edx
  syscall
  cmp $-9, %rax
  jne bad
  mov $1, %eax
  mov $2, %edi
  syscall
  cmp $-9, %rax
  jne bad
#else
  cmpb $109, (%rax)
  jne bad
#endif

  mov $2, %eax
  lea input(%rip), %rdi
  xor %esi, %esi
  xor %edx, %edx
  syscall
  test %rax, %rax
  js bad
#ifdef SODS_OWNED_STDOUT_ONLY
  test %rax, %rax /* The first ordinary open uses the absent fd 0. */
  jne bad
#endif
  mov %eax, %r12d

  movb $65, first(%rip)
  mov $1, %eax
  mov $1, %edi
  lea first(%rip), %rsi
  mov $1, %edx
  syscall
  cmp $1, %rax
  jne bad

  mov $40, %eax
  mov $1, %edi
  mov %r12d, %esi
  xor %edx, %edx
  mov $1, %r10d
  syscall
  cmp $1, %rax
  jne bad

#ifdef SODS_CAPTURE_RESIDENT_PRESSURE
  /* Q/K still have room, but the first send owns the only R pin. */
  mov $40, %eax
  mov $2, %edi
  mov %r12d, %esi
  xor %edx, %edx
  mov $1, %r10d
  syscall
  cmp $1, %rax
  jne bad
#endif

  movb $88, first(%rip)
  movb $67, last(%rip)
  mov $1, %eax
#if defined(SODS_PHYSICAL_ONE_ENDPOINT) || defined(SODS_OWNED_STDOUT_ONLY)
  mov $1, %edi
#else
  mov $2, %edi
#endif
  lea last(%rip), %rsi
  mov $1, %edx
  syscall
  cmp $1, %rax
  jne bad
  movb $89, last(%rip)

#ifdef SODS_OWNED_STDOUT_ONLY
  /* sendfile wrote the ELF magic's 0x7f; the original OFD now reads ELF. */
  xor %eax, %eax
  mov %r12d, %edi
  lea suffix(%rip), %rsi
  mov $3, %edx
  syscall
  cmp $3, %rax
  jne bad
  cmpb $69, suffix(%rip)
  jne bad
  cmpb $76, suffix+1(%rip)
  jne bad
  cmpb $70, suffix+2(%rip)
  jne bad
#endif

  mov $42, %edi
  jmp finish
bad:
  mov $98, %edi
finish:
  mov $60, %eax
  syscall
  ud2

.section .rodata
#ifdef SODS_OWNED_STDOUT_ONLY
input: .asciz "/bin/owned.elf"
#else
input: .asciz "/source"
#endif
.section .data
first: .byte 0
last: .byte 0
#ifdef SODS_OWNED_STDOUT_ONLY
suffix: .space 3
#endif
.section .note.GNU-stack,"",@progbits

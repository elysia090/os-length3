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
  cmpb $109, (%rax)
  jne bad

  mov $2, %eax
  lea input(%rip), %rdi
  xor %esi, %esi
  xor %edx, %edx
  syscall
  test %rax, %rax
  js bad
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
#ifdef SODS_PHYSICAL_ONE_ENDPOINT
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

  mov $42, %edi
  jmp finish
bad:
  mov $98, %edi
finish:
  mov $60, %eax
  syscall
  ud2

.section .rodata
input: .asciz "/source"
.section .data
first: .byte 0
last: .byte 0
.section .note.GNU-stack,"",@progbits

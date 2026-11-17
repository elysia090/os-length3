/* Fixed-memory non-TTY read/write profile; no libc or runtime setup. */
.global _start
.section .text
_start:
  /* Wrong-direction descriptors fail before touching or consuming input. */
  xor %eax,%eax
  mov $1,%edi
  lea buffer(%rip),%rsi
  mov $32,%edx
  syscall
  cmp $-9,%rax
  jne bad
  mov $1,%eax
  xor %edi,%edi
  syscall
  cmp $-9,%rax
  jne bad
  /* Full target validation precedes irreversible input consumption. */
  xor %eax,%eax
  xor %edi,%edi
  mov $0x7ffffffff000,%rsi
  mov $1,%edx
  syscall
  cmp $-14,%rax
  jne bad
  /* Zero length never accesses the invalid pointer. */
  xor %eax,%eax
  xor %edx,%edx
  syscall
  test %rax,%rax
  jne bad
  xor %eax,%eax
  lea buffer(%rip),%rsi
  mov $32,%edx
  syscall
  test %rax,%rax
  jle bad
  mov %rax,%r12
  mov %rax,%rdx
  mov $1,%eax
  mov $1,%edi
  syscall
  cmp %r12,%rax
  jne bad
  mov $1,%eax
  mov $2,%edi
  lea marker(%rip),%rsi
  mov $4,%edx
  syscall
  cmp $4,%rax
  jne bad
  xor %eax,%eax
  xor %edi,%edi
  lea buffer(%rip),%rsi
  mov $32,%edx
  syscall
  test %rax,%rax
  jne bad
  mov $23,%edi
  jmp done
bad:
  mov $99,%edi
done:
  mov $60,%eax
  syscall
.section .rodata
marker: .ascii "err\n"
.section .bss
.align 16
buffer: .skip 32
.section .note.GNU-stack,"",@progbits

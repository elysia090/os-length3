/* Static raw-syscall child: two real FS bases, no libc/thread host state. */
.global _start
.section .text
_start:
  mov $158,%eax
  mov $0x1002,%edi
  lea first(%rip),%rsi
  syscall
  test %rax,%rax
  jne fail
  mov %fs:0,%rsi
  mov $1,%eax
  mov $1,%edi
  mov $4,%edx
  syscall
  cmp $4,%rax
  jne fail
  mov $158,%eax
  mov $0x1002,%edi
  lea second(%rip),%rsi
  syscall
  test %rax,%rax
  jne fail
  mov %fs:0,%rsi
  mov $1,%eax
  mov $1,%edi
  mov $4,%edx
  syscall
  cmp $4,%rax
  jne fail
  xor %edi,%edi
  mov $60,%eax
  syscall
  ud2
fail:
  mov $91,%edi
  mov $60,%eax
  syscall
  ud2
.section .rodata
.align 8
first: .quad one
second: .quad two
one: .ascii "one\n"
two: .ascii "two\n"
.section .note.GNU-stack,"",@progbits

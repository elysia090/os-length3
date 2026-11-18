/* getpid exists in the legacy runtime but is outside the managed profile. */
.global _start
.section .text
_start:
  mov $39, %eax
  syscall
  xor %edi, %edi
  mov $60, %eax
  syscall
  ud2
.section .note.GNU-stack,"",@progbits

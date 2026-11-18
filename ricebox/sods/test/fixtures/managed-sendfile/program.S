/* Actual translated Worker negative gate, not a successful sendfile fixture.
 * If sendfile returns at all (including false zero/errno), emit a failure marker.
 * The separately built control opens/closes the same input and exits42. */
.global _start
.section .text
_start:
  mov $2, %eax
  lea input(%rip), %rdi
  xor %esi, %esi
  xor %edx, %edx
  syscall
  cmp $3, %rax
  jne bad
#ifdef SODS_SENDFILE_CONTROL
  mov $3, %eax
  mov $3, %edi
  syscall
  test %rax, %rax
  jne bad
  mov $42, %edi
#else
  mov $40, %eax
  mov $1, %edi
  mov $3, %esi
  xor %edx, %edx
#ifndef SODS_SENDFILE_COUNT
#define SODS_SENDFILE_COUNT 6
#endif
  mov $SODS_SENDFILE_COUNT, %r10d
  syscall
  mov $1, %eax
  mov $1, %edi
  lea resumed(%rip), %rsi
  mov $resumed_end-resumed, %edx
  syscall
  mov $99, %edi
#endif
  jmp finish
bad:
  mov $98, %edi
finish:
  mov $60, %eax
  syscall
  ud2
.section .rodata
input: .asciz "/input"
resumed: .ascii "SHOULD-NOT-RESUME"
resumed_end:
.section .note.GNU-stack,"",@progbits

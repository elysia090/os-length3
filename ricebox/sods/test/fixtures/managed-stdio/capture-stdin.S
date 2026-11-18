/* Test one explicit borrowed input. No host output is implied by that loan. */
.global _start
.text
.macro want n
  cmp $\n,%rax
  jne bad
.endm
_start:
#if defined SODS_STDIN_ABSENT || defined SODS_STDIN_BAD_FD
  xor %eax,%eax
  xor %edi,%edi
  lea buffer(%rip),%rsi
  mov $8,%edx
  syscall
  want -9
#else
  xor %eax,%eax
  xor %edi,%edi
  mov $0x7ffffffff000,%rsi
  mov $1,%edx
  syscall
  want -14
  xor %eax,%eax
  xor %edx,%edx
  syscall
  want 0
  xor %eax,%eax
  lea buffer(%rip),%rsi
  mov $8,%edx
  syscall
  want 6
  xor %eax,%eax
  lea tail(%rip),%rsi
  mov $8,%edx
  syscall
  want 0
  mov $3,%eax
  syscall
  want 0
  xor %eax,%eax
  syscall
  want -9
  mov $1,%eax
  mov $1,%edi
  lea buffer(%rip),%rsi
  mov $3,%edx
  syscall
  cmp $-9,%rax
  je physical_error
  want 3
  mov $1,%eax
  mov $2,%edi
  lea buffer+3(%rip),%rsi
  mov $3,%edx
  syscall
  want 3
#endif
  xor %edi,%edi
  jmp done
physical_error:
  mov $42,%edi
  jmp done
bad:
  mov $99,%edi
done:
  mov $60,%eax
  syscall
  ud2
.bss
.balign 8
buffer: .skip 8
tail: .skip 8
.section .note.GNU-stack,"",@progbits

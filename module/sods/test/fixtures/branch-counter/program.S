/* JRCXZ tests RCX, not arithmetic flags. Nonzero falls through; zero branches. */
.global _start
.section .text
_start:
 mov $1,%ecx
 jrcxz bad
 mov $0,%ecx
 jrcxz taken
bad:
 mov $1,%edi
 jmp finish
taken:
 mov $0,%edi
finish:
 mov $60,%eax
 syscall
 ud2
.section .note.GNU-stack,"",@progbits

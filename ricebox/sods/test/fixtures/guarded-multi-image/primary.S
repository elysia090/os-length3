.file "primary.S"
.section .text,"ax",@progbits
.globl _start
.set second_ro, bias + 288     # after ELF64 Ehdr and four Phdrs
.set second_rw, bias + 8192
.macro say from
  mov $1,%eax
  mov $1,%edi
  mov $\from,%esi
  mov $8,%edx
  syscall
.endm
_start:
.if scenario == 3
  # Pinned RW data begins with RET's opcode, but remains NX.
  call rw_target
.elseif scenario == 4
  # A real scalar store into the companion's RO page must fault.
  mov $second_ro+8,%esp
  movabs $0x1122334455667788,%rax
  push %rax
.elseif scenario == 5
  mov $10,%eax
  mov $bias,%edi
  mov $4096,%esi
  mov $0,%edx
  syscall
  say second_ro
  mov %rax,%rdi      # -EFAULT, represented as exit 242
  mov $60,%eax
  syscall
.else
  # A real rel32 CALL to the independent image, then its real RET back.
  call companion_entry
  # Write the returned value into the distinct checked RW page, not into
  # code or a kernel alias. PUSH still drives the Unit 4 checked scalar
  # store, with RSP explicitly restored before any call or syscall.
  mov %rsp,%rbx
  mov $second_rw+8,%esp
  push %rax
  mov %rbx,%rsp
  say second_ro
  say second_rw
.if scenario == 1 || scenario == 2
  mov $bias+4096,%edi
  mov $4096,%esi
  mov $1,%edx
.if scenario == 1
  mov $10,%eax       # mprotect(second RX page, 4096, PROT_READ)
.else
  mov $11,%eax       # munmap(second RX page, 4096) in the scoped profile
.endif
  syscall
  mov %rax,%rbp      # preserve native syscall return for the task receipt
  say second_ro      # primary and both data pages survive this retirement
  say second_rw
.endif
  call companion_entry       # same VA and the same previously executed bytes
.endif
  mov $37,%edi
  mov $60,%eax
  syscall
.section .note.GNU-stack,"",@progbits

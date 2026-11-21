// Native mapping/CPU control for the same pair of hand-picked local ELFs.
// This intentionally does not call dlopen, GNU ld.so, or a symbol resolver.
#define _GNU_SOURCE
#include <assert.h>
#include <elf.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

static uintptr_t map_elf(const char *path, uintptr_t bias, int kind) {
  Elf64_Ehdr e;
  Elf64_Phdr p;
  const uintptr_t page=4096;
  const int fd=open(path,O_RDONLY|O_CLOEXEC);
  assert(fd>=0 && sysconf(_SC_PAGESIZE)==(long)page);
  assert(pread(fd,&e,sizeof e,0)==sizeof e && e.e_type==kind && e.e_machine==EM_X86_64);
  assert(e.e_phoff==sizeof e && e.e_phentsize==sizeof p && e.e_phnum==(kind==ET_EXEC ? 2 : 4));
  for (unsigned i=0;i<e.e_phnum;i++) {
    assert(pread(fd,&p,sizeof p,(off_t)(e.e_phoff+i*sizeof p))==sizeof p);
    if (i==e.e_phnum-1u) { assert(p.p_type==PT_GNU_STACK && p.p_flags==(PF_R|PF_W)); continue; }
    assert(p.p_type==PT_LOAD && p.p_filesz==p.p_memsz && p.p_filesz>0 && p.p_filesz<=page);
    assert(p.p_align==page && p.p_vaddr%page==0 && p.p_offset%page==0);
    assert(!(p.p_flags&PF_X) || !(p.p_flags&PF_W));
    const int flags=(p.p_flags&PF_R?PROT_READ:0)|(p.p_flags&PF_W?PROT_WRITE:0)|(p.p_flags&PF_X?PROT_EXEC:0);
    void *address=(void *)(bias+p.p_vaddr);
    assert(mmap(address,page,flags,MAP_FIXED_NOREPLACE|MAP_PRIVATE,fd,(off_t)p.p_offset)==address);
  }
  assert(close(fd)==0);
  return bias+e.e_entry;
}

int main(int argc,char **argv) {
  assert(argc==4);
  const struct rlimit lim={0,0};
  assert(setrlimit(RLIMIT_CORE,&lim)==0);
  const uintptr_t bias=strtoul(argv[3],NULL,0);
  assert(bias==0x600000 || bias==0x800000);
  const uintptr_t entry=map_elf(argv[1],0,ET_EXEC);
  assert(map_elf(argv[2],bias,ET_DYN)==bias+4096);
  ((void(*)(void))entry)();
  return 121; // the fixture goes through the real sys_exit, never this branch
}

#ifndef FFI_CONFIG_H
#define FFI_CONFIG_H
/* Linux x86-64 test-only configuration; not a release package. */
#define STDC_HEADERS 1
#define HAVE_ALLOCA_H 1
#define HAVE_MEMCPY 1
#define HAVE_AS_CFI_PSEUDO_OP 1
#define HAVE_AS_X86_64_UNWIND_SECTION_TYPE 1
#define HAVE_AS_X86_PCREL 1
#define HAVE_MKOSTEMP 1
#define HAVE_MEMFD_CREATE 1
#define HAVE_MMAP 1
#define SIZEOF_SIZE_T 8
#define SIZEOF_DOUBLE 8
#define SIZEOF_LONG_DOUBLE 16
#define FFI_EXEC_STATIC_TRAMP 1
#ifdef LIBFFI_ASM
# define FFI_HIDDEN(name) .hidden name
#else
# define FFI_HIDDEN __attribute__((visibility("hidden")))
#endif
#endif

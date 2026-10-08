# One source population for native and cold-Wasm builds of the x86 frontend.
X86_SOURCES = src/elf.c src/decode.c src/semantics.c src/enter.c src/string-io.c src/x87-value.c src/x87-ieee.c src/x87-status.c src/x87-arithmetic.c src/unsigned-divide.c src/vector-projection.c src/vector-binary.c \
	src/compose.c src/compact.c src/normalize.c src/sweep.c src/region.c src/alu.c
X86_SOURCES += src/translate-byte.c
X86_SOURCES += src/x87-integer-store.c
X86_SOURCES += src/return.c

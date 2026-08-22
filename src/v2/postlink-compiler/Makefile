# The post-link compiler builds with gcc and nothing else.
#
#   make            the C library, native drivers and the self-test
#   make library    only libpostlink.a (include/ + src/ + this Makefile)
#   make check      run the self-test
#   make parity     additionally prove the C codec against the Python writer
#   make guest      a static binary for the x86 guest's own toolchain
#
# The library sources are freestanding: no libc, no builtins, no target
# assumptions beyond two's complement.  Only the drivers under tools/ and
# check/ use libc, so `make wasm` reuses the same objects unchanged.

# `?=` would not override make's built-in default of `cc`, so name gcc only
# when the value is still that default.
ifeq ($(origin CC),default)
CC = gcc
endif
CFLAGS  ?= -O2 -g
WARN     = -Wall -Wextra -Wpedantic -Wshadow -Wconversion -std=c11
INCLUDE  = -Iinclude
BUILD   ?= build
AR      ?= ar

ZYDIS = third_party/zydis
ZYDIS_INCLUDE = -I$(ZYDIS)/include -I$(ZYDIS)/dependencies/zycore/include -I$(ZYDIS)/src
ZYDIS_DEFINES = -DZYDIS_STATIC_BUILD -DZYDIS_DISABLE_ENCODER \
	-DZYDIS_DISABLE_FORMATTER -DZYDIS_DISABLE_SEGMENT -DZYDIS_DISABLE_KNC
ZYDIS_SOURCES = Register SharedData DecoderData Decoder Mnemonic
ZYDIS_OBJECTS = $(patsubst %,$(BUILD)/zydis/%.o,$(ZYDIS_SOURCES))

LIB_SOURCES = src/format.c src/continuation.c src/machine.c src/physical.c src/boot.c src/deflate.c src/elf.c src/x86.c src/semantic.c src/block.c src/transfer.c src/executable.c src/projection.c src/entrymap.c src/closure.c src/residual.c src/instantiation.c src/wasm.c src/sha256.c src/index.c src/delivery.c src/directory.c src/chain.c src/dispatch.c src/trace.c src/template.c src/plan.c src/compose.c src/compact.c src/rewrite.c src/sweep.c src/region.c src/alu.c src/affine.c
LIB_OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(LIB_SOURCES))
LIBRARY = $(BUILD)/libpostlink.a

.PHONY: all library tools check direct-check isa-completeness-check \
	linked-completeness-check mmu-completeness-check parity opcodes guest \
	wasm clean

TOOLS = postlink-inspect postlink-elf postlink-admit postlink-chain postlink-repack postlink-trace postlink-template postlink-compose postlink-coverage postlink-boundaries postlink-blocks postlink-compiler postlink-verify

all: library tools $(BUILD)/selftest

# This is the standalone product boundary.  It deliberately has no dependency
# on tools/, check/, Python, JavaScript, an artifact, or the repository around
# this directory.  Repository drivers link the same archive below instead of
# acquiring a second compilation route.
library: $(LIBRARY)

$(LIBRARY): $(LIB_OBJECTS) $(ZYDIS_OBJECTS) | $(BUILD)
	$(AR) rcs $@ $^

tools: $(patsubst %,$(BUILD)/%,$(TOOLS))

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/zydis:
	mkdir -p $(BUILD)/zydis

# Every object depends on every header.  The headers are few and small, and a
# stale object compiled against an older struct layout reads the wrong offsets
# without any diagnostic -- which is exactly what happened once.
HEADERS = $(wildcard include/postlink/*.h)

$(BUILD)/%.o: src/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(ZYDIS_INCLUDE) $(ZYDIS_DEFINES) -ffreestanding -c $< -o $@

$(BUILD)/zydis/%.o: $(ZYDIS)/src/%.c | $(BUILD)/zydis
	$(CC) $(CFLAGS) $(ZYDIS_INCLUDE) $(ZYDIS_DEFINES) -ffreestanding \
		-ffunction-sections -fdata-sections -c $< -o $@

$(BUILD)/postlink-inspect: tools/inspect.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-elf: tools/elf.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(ZYDIS_INCLUDE) $(ZYDIS_DEFINES) \
		$(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-admit: tools/admit.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-chain: tools/chain.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-repack: tools/repack.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-trace: tools/trace.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-template: tools/template.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-compose: tools/compose.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-coverage: tools/coverage.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-boundaries: tools/boundaries.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(ZYDIS_INCLUDE) $(ZYDIS_DEFINES) \
		$(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-blocks: tools/blocks.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-compiler: tools/blocks.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/postlink-verify: tools/verify.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/selftest: check/selftest.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/completeness: check/completeness.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

$(BUILD)/emitter-fixture: check/emit_fixture.c $(LIBRARY) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.a,$^) -o $@

check: $(BUILD)/selftest
	$(BUILD)/selftest

# Repository integration gate: two ordinary compiler-output Wasm functions
# chain through vm.wasm's shared table without an X86B/STEP record or a host
# callback.  The standalone C library above still needs only gcc and ar.
direct-check: check $(BUILD)/emitter-fixture
	$(BUILD)/emitter-fixture $(BUILD)/emitted-blocks.wasm \
		$(BUILD)/emitted-executable.root \
		$(BUILD)/emitted-binding.node $(BUILD)/emitted-module.node \
		$(BUILD)/emitted-resource.node $(BUILD)/emitted-resource.page \
		$(BUILD)/emitted-entry-page.rows $(BUILD)/emitted-entry-tail.row \
		$(BUILD)/emitted-residual.root \
		$(BUILD)/emitted-residual-state.page \
		$(BUILD)/emitted-residual-edge.page \
		$(BUILD)/emitted-instantiation.page \
		$(BUILD)/emitted-parameter.page \
		$(BUILD)/emitted-cold.wasm
	PYTHONPATH=.. python3 ../vm/wasm/build.py --direct-check \
		--emitted-module $(abspath $(BUILD)/emitted-blocks.wasm) \
		--emitted-cold-module $(abspath $(BUILD)/emitted-cold.wasm) \
		--executable-root $(abspath $(BUILD)/emitted-executable.root) \
		--residual-root $(abspath $(BUILD)/emitted-residual.root) \
		--executable-node $(abspath $(BUILD)/emitted-binding.node) \
		--executable-node $(abspath $(BUILD)/emitted-module.node) \
		--executable-node $(abspath $(BUILD)/emitted-resource.node) \
		--executable-resource $(abspath $(BUILD)/emitted-resource.page) \
		--executable-resource $(abspath $(BUILD)/emitted-entry-page.rows) \
		--executable-resource $(abspath $(BUILD)/emitted-entry-tail.row) \
		--executable-resource $(abspath $(BUILD)/emitted-residual-state.page) \
		--executable-resource $(abspath $(BUILD)/emitted-residual-edge.page) \
		--executable-resource $(abspath $(BUILD)/emitted-instantiation.page) \
		--executable-resource $(abspath $(BUILD)/emitted-parameter.page) \
		$(COMPLETENESS_FLAG)

# These are intentionally separate from `check`: while closure is incomplete
# they must be red.  They prevent a valid decode, an anonymous machine barrier
# or a terminal #PF token from being mistaken for executable semantics.
isa-completeness-check: $(BUILD)/completeness
	$(BUILD)/completeness

linked-completeness-check: $(BUILD)/postlink-elf
	test -n "$(X86_IMAGE)"
	$(BUILD)/postlink-elf $(X86_IMAGE) --alias-require-semantics

mmu-completeness-check: COMPLETENESS_FLAG = --completeness-check
mmu-completeness-check: direct-check

# The opcode predicates are generated from qm.steppage rather than transcribed,
# because neither of them is a contiguous range.  Fails if the header drifts.
opcodes:
	python3 check/generate_opcodes.py --check

# Proves the C codec against kernel/x86snapshot.py while both still exist.
# This is a repository check, not part of the distributable.
parity: opcodes check
	$(BUILD)/selftest --vectors | python3 check/format_parity.py

# The guest links statically: the read-only /usr layer has no dynamic loader
# on the principal tools, and a post-link compiler that needs one could not
# run inside the machine it compiles for.
guest: CFLAGS += -static
guest: all

# The browser runtime compiles the same objects for wasm32.  It needs no
# separate source tree, which is the point of keeping the library
# freestanding.
wasm: CC = clang
wasm: CFLAGS += --target=wasm32 -nostdlib
wasm: $(LIB_OBJECTS)

clean:
	rm -rf $(BUILD)

# The post-link compiler builds with gcc and nothing else.
#
#   make            the native driver and the self-test
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

LIB_SOURCES = src/format.c src/continuation.c src/machine.c src/directory.c src/chain.c src/trace.c src/template.c src/plan.c src/compose.c src/compact.c src/rewrite.c src/sweep.c src/region.c src/alu.c src/affine.c
LIB_OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(LIB_SOURCES))

.PHONY: all check parity opcodes guest wasm clean

TOOLS = postlink-inspect postlink-admit postlink-chain postlink-repack postlink-trace postlink-template postlink-compose

all: $(patsubst %,$(BUILD)/%,$(TOOLS)) $(BUILD)/selftest

$(BUILD):
	mkdir -p $(BUILD)

# Every object depends on every header.  The headers are few and small, and a
# stale object compiled against an older struct layout reads the wrong offsets
# without any diagnostic -- which is exactly what happened once.
HEADERS = $(wildcard include/postlink/*.h)

$(BUILD)/%.o: src/%.c $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) -ffreestanding -c $< -o $@

$(BUILD)/postlink-inspect: tools/inspect.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/postlink-admit: tools/admit.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/postlink-chain: tools/chain.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/postlink-repack: tools/repack.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/postlink-trace: tools/trace.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/postlink-template: tools/template.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/postlink-compose: tools/compose.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

$(BUILD)/selftest: check/selftest.c $(LIB_OBJECTS) $(HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDE) $(filter %.c %.o,$^) -o $@

check: $(BUILD)/selftest
	$(BUILD)/selftest

# The opcode predicates are generated from qm.steppage rather than transcribed,
# because neither of them is a contiguous range.  Fails if the header drifts.
opcodes:
	python3 check/generate_opcodes.py --check

# Proves the C codec against kernel/x86snapshot.py while both still exist.
# This is a repository check, not part of the distributable.
parity: opcodes $(BUILD)/selftest
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

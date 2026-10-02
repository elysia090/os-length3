CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include -I../optimized-x86/include \
	-I../machine-abi/include -I../x86/include
BUILD ?= build
SOURCES = src/read-optimized-x86.c src/lower-machine-abi.c \
	src/emit-function.c src/emit-dispatch.c src/emit-module.c src/compile-cut.c \
	src/emit-cut.c src/lower-register.c src/lower-memory.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
PROVIDER_LIBRARIES = ../optimized-x86/build/liboptimized-x86.a \
	../x86/build/libx86.a ../support/build/libsupport.a

.PHONY: all check cut-check cut-fixture-check memory-fixture-check accepted-input-check projection-check clean
all: $(BUILD)/libwasm-compiler.a $(BUILD)/wasm-compiler

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -MMD -MP -ffreestanding -c $< -o $@

-include $(OBJECTS:.o=.d)

$(BUILD)/libwasm-compiler.a: $(OBJECTS)
	$(AR) rcs $@ $^

$(BUILD)/wasm-compiler: cli/main.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< \
		$(BUILD)/libwasm-compiler.a ../optimized-x86/build/liboptimized-x86.a \
		../x86/build/libx86.a ../support/build/libsupport.a -o $@

$(BUILD)/admission-check: check/admission.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< \
		$(BUILD)/libwasm-compiler.a ../optimized-x86/build/liboptimized-x86.a \
		../x86/build/libx86.a ../support/build/libsupport.a -o $@

$(BUILD)/cut-check: check/cut.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/cut.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/memory-cut-check: check/memory-cut.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/memory-cut.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

cut-check: all $(BUILD)/cut-check
	@test -n "$(INPUT)" || { printf 'set INPUT to the post-linked cut fixture\n' >&2; exit 2; }
	$(BUILD)/cut-check "$(INPUT)"

cut-fixture-check: $(BUILD)/cut-check
	$(MAKE) -C ../postlink-compiler all
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		check/cut-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf"

memory-fixture-check: $(BUILD)/memory-cut-check
	$(MAKE) -C ../postlink-compiler all
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 0 20 22; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DMEMORY_CASE=$$rank check/memory-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	if [ $$rank = 22 ]; then \
		if $(BUILD)/memory-cut-check "$$scratch/optimized.elf" "$$scratch/cut"; then exit 1; fi; \
	else $(BUILD)/memory-cut-check "$$scratch/optimized.elf" "$$scratch/cut"; fi; \
	done

# C rejection/emission checks are separate from the Node execution oracle and
# the still-red whole-image/browser product gates.
check: all $(BUILD)/admission-check cut-fixture-check memory-fixture-check
	$(BUILD)/admission-check
	@! grep -REn '#include <postlink/|machine-artifact|STEP|Pyodide|Python' include src
	@! grep -REn 'postlink\.program|OX_PROGRAM|ox_program' include src

accepted-input-check: all $(BUILD)/admission-check
	@test -n "$(INPUT)" || { printf 'set INPUT to a proved optimized ELF\n' >&2; exit 2; }
	$(BUILD)/admission-check "$(INPUT)"

# Deliberately red until the real optimized input produces executable Wasm.
projection-check: all
	@test -n "$(INPUT)" || { printf 'set INPUT to a proved optimized ELF\n' >&2; exit 2; }
	bash ../../../data/oracle/check-wasm-projection.sh \
		$(BUILD)/wasm-compiler "$(INPUT)"

clean:
	rm -rf $(BUILD)

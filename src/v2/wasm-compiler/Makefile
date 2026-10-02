CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include -I../optimized-x86/include \
	-I../machine-abi/include -I../x86/include
BUILD ?= build
SOURCES = src/read-optimized-x86.c src/lower-machine-abi.c \
	src/emit-function.c src/emit-dispatch.c src/emit-module.c src/compile-cut.c \
	src/emit-cut.c src/lower-register.c src/lower-memory.c src/lower-stack.c src/lower-system.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
PROVIDER_LIBRARIES = ../optimized-x86/build/liboptimized-x86.a \
	../x86/build/libx86.a ../support/build/libsupport.a

.PHONY: all check fixture-tools cut-check cut-fixture-check memory-fixture-check stack-fixture-check accepted-input-check projection-check clean
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

$(BUILD)/stack-cut-check: check/stack-cut.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/stack-cut.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/fetch-cut-check: check/fetch-cut.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/fetch-fixture.elf: check/fetch-fixture.S | $(BUILD)
	$(CC) -nostdlib -no-pie -Wl,--build-id=none $< -o $@

$(BUILD)/code-cut-check: check/code-cut.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

cut-check: all $(BUILD)/cut-check
	@test -n "$(INPUT)" || { printf 'set INPUT to the post-linked cut fixture\n' >&2; exit 2; }
	$(BUILD)/cut-check "$(INPUT)"

# One prerequisite per make invocation: parallel fixtures must not rebuild and
# truncate the same CLI while another fixture is executing it.
fixture-tools:
	$(MAKE) -C ../postlink-compiler all

cut-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 0 16 17 18 19 20 21; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCUT_SPECIAL=$$rank check/cut-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done

memory-fixture-check: $(BUILD)/memory-cut-check fixture-tools
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
stack-fixture-check: $(BUILD)/stack-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 0 1 2 3 4 5 6 7 8 9 10; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DSTACK_CASE=$$rank check/stack-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/stack-cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done

check: all $(BUILD)/admission-check cut-fixture-check memory-fixture-check stack-fixture-check $(BUILD)/fetch-cut-check $(BUILD)/fetch-fixture.elf $(BUILD)/code-cut-check
	$(BUILD)/admission-check
	$(BUILD)/fetch-cut-check $(BUILD)/fetch-fixture.elf
	$(BUILD)/code-cut-check
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

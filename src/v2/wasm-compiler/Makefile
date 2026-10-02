CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include -I../optimized-x86/include \
	-I../machine-abi/include -I../x86/include
BUILD ?= build
WASM_CC ?= clang
WASM_FLAGS = --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib \
	-Wl,--no-entry,--strip-all -Xlinker --import-memory=machine,memory \
	-Wl,--export=compiler_arena_min,--export=compiler_report_bytes,--export=compiler_close \
	-Wl,--export=compiler_open_elf,--export=compiler_open_pages,--export=compiler_emit
SOURCES = src/read-optimized-x86.c src/lower-machine-abi.c \
	src/emit-function.c src/emit-dispatch.c src/emit-module.c src/compile-cut.c \
	src/emit-cut.c src/lower-register.c src/lower-shift.c src/lower-memory.c src/lower-stack.c src/lower-system.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
PROVIDER_LIBRARIES = ../optimized-x86/build/liboptimized-x86.a \
	../x86/build/libx86.a ../support/build/libsupport.a

.PHONY: all wasm check fixture-tools cut-check cut-fixture-check shift-fixture-check condition-fixture-check memory-fixture-check stack-fixture-check accepted-input-check projection-check clean
all: $(BUILD)/libwasm-compiler.a $(BUILD)/wasm-compiler

# Independent cold compiler memory/stack; never the VM's runtime decoder.
ZYDIS = ../x86/third_party/zydis
COLD_SOURCES = wasm/entry.c wasm/memory.c $(filter-out src/emit-module.c src/emit-dispatch.c,$(SOURCES)) \
	../x86/src/elf.c ../x86/src/decode.c ../optimized-x86/src/proof.c \
	../optimized-x86/src/reader.c ../support/src/sha256.c \
	$(addprefix $(ZYDIS)/src/,$(addsuffix .c,Register SharedData DecoderData Decoder Mnemonic))
wasm: $(BUILD)/wasm-compiler.wasm
$(BUILD)/wasm-compiler.wasm: $(COLD_SOURCES) $(wildcard include/wasm-compiler/*.h src/*.h) | $(BUILD)
	$(WASM_CC) $(WASM_FLAGS) $(INCLUDES) -I$(ZYDIS)/include \
		-I$(ZYDIS)/dependencies/zycore/include -I$(ZYDIS)/src \
		-DZYAN_NO_LIBC -DZYDIS_STATIC_BUILD -DZYDIS_DISABLE_ENCODER \
		-DZYDIS_DISABLE_FORMATTER -DZYDIS_DISABLE_SEGMENT -DZYDIS_DISABLE_KNC \
		$(COLD_SOURCES) -o $@

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -MMD -MP -ffreestanding -c $< -o $@

-include $(OBJECTS:.o=.d)

$(BUILD)/libwasm-compiler.a: $(OBJECTS)
	$(AR) rcs $@ $^

$(BUILD)/wasm-compiler: cli/main.c cli/io.c cli/prefix.c cli/io.h $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/main.c cli/io.c cli/prefix.c \
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

shift-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 1 2 3 4 5 6 7 8 9 10 11 12; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DSHIFT_CASE=$$rank check/shift-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done

condition-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 1 2 3 4 5 6; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCONDITION_CASE=$$rank check/condition-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done

memory-fixture-check: $(BUILD)/memory-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 0 20 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DMEMORY_CASE=$$rank check/memory-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	if [ $$rank = 22 ] || [ $$rank = 45 ]; then \
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

check: all $(BUILD)/admission-check cut-fixture-check shift-fixture-check condition-fixture-check memory-fixture-check stack-fixture-check $(BUILD)/fetch-cut-check $(BUILD)/fetch-fixture.elf $(BUILD)/code-cut-check
	$(BUILD)/admission-check
	$(BUILD)/fetch-cut-check $(BUILD)/fetch-fixture.elf
	$(BUILD)/code-cut-check
	bash ../../../data/oracle/check-wasm-cli.sh $(BUILD)/wasm-compiler
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

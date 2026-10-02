CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include -I../machine-abi/include
BUILD ?= build
WASM_CC ?= clang
WASM_FLAGS = --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib \
	-Wl,--no-entry,--strip-all -Xlinker --import-memory=machine,memory \
	-Wl,--export=vm_arena_min,--export=vm_open,--export=vm_close,--export=vm_bind_state,--export=vm_access
WASM_FLAGS += -Wl,--export=vm_boot_prepare,--export=vm_boot_project,--export=vm_boot_initial_state
WASM_FLAGS += -Wl,--export-table,--growable-table,--export=vm_slot_min,--export=vm_bind_execution,--export=vm_run,--export=vm_completed,--export=vm_source_retired
WASM_FLAGS += -Wl,--export=vm_boot_initial_segments,--export=vm_bind_segments,--export=vm_segment
WASM_FLAGS += -Wl,--export=vm_reserve,--export=vm_commit,--export=vm_abort,--export=vm_table,--export=vm_return
WASM_FLAGS += -Wl,--export=vm_control
SOURCES = core/resource.c core/memory.c core/mmu.c core/boot.c core/execution.c core/segments.c core/tables.c core/control.c core/registers.c
OBJECTS = $(patsubst core/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check wasm clean
# Resource and resident RAM boundaries; not a bootable machine or complete MMU.
all: $(BUILD)/libvm.a

# The provider shares ordinary machine memory with generated functions. It has
# no WASI, source-decoder or JavaScript instruction/byte callback imports.
wasm: $(BUILD)/vm.wasm

$(BUILD)/vm.wasm: wasm/entry.c core/memory.c core/mmu.c core/boot.c core/execution.c core/segments.c core/tables.c core/control.c core/registers.c core/memory-internal.h core/segments-internal.h \
	include/vm/memory.h include/vm/mmu.h include/vm/boot.h include/vm/execution.h ../support/include/support/types.h \
	../machine-abi/include/machine/state.h ../machine-abi/include/machine/memory.h \
	include/vm/segments.h include/vm/tables.h include/vm/control.h include/vm/registers.h ../machine-abi/include/machine/segments.h \
	../machine-abi/include/machine/result.h ../machine-abi/include/machine/entry.h | $(BUILD)
	$(WASM_CC) $(WASM_FLAGS) $(WARN) $(INCLUDES) wasm/entry.c core/memory.c core/mmu.c core/boot.c core/execution.c core/segments.c core/tables.c core/control.c core/registers.c -o $@

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: core/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -MMD -MP -ffreestanding -c $< -o $@

-include $(OBJECTS:.o=.d)

$(BUILD)/libvm.a: $(OBJECTS)
	$(AR) rcs $@ $^

$(BUILD)/resource-check: check/resource.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/memory-check: check/memory.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/mmu-check: check/mmu.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/boot-check: check/boot.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/execution-check: check/execution.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/segments-check: check/segments.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/registers-check: check/registers.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -I../x86/include $< $(BUILD)/libvm.a -o $@

check: all $(BUILD)/resource-check $(BUILD)/memory-check $(BUILD)/mmu-check $(BUILD)/boot-check $(BUILD)/execution-check $(BUILD)/segments-check $(BUILD)/registers-check
	$(BUILD)/resource-check
	$(BUILD)/memory-check
	$(BUILD)/mmu-check
	$(BUILD)/boot-check
	$(BUILD)/execution-check
	$(BUILD)/segments-check
	$(BUILD)/registers-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|wasm-compiler)/|Pyodide|Python|STEP' include core

clean:
	rm -rf $(BUILD)

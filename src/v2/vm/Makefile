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
WASM_FLAGS += -Wl,--export=vm_reserve_pair,--export=vm_commit_pair
WASM_FLAGS += -Wl,--export=vm_control,--export=vm_code,--export=vm_grow,--export=vm_page_prepare,--export=vm_page_commit,--export=vm_page_count
WASM_FLAGS += -Wl,--export=vm_fault,--export=vm_iret,--export=vm_msr
WASM_FLAGS += -Wl,--export=vm_debug
WASM_FLAGS += -Wl,--export=vm_io,--export=vm_time,--export=vm_clock_commit,--export=vm_rtc_start
WASM_FLAGS += -Wl,--export=vm_source_query,--export=vm_source_extend,--export=vm_source_publish,--export=vm_sources_reset
WASM_FLAGS += -Wl,--export=vm_source_capacity,--export=vm_source_metadata_bytes
SOURCES = core/resource.c core/memory.c core/mmu.c core/boot.c core/supply.c core/execution.c core/segments.c core/tables.c core/control.c core/registers.c core/msr.c core/debug.c core/exception.c core/source.c core/clock.c core/pit.c core/pic.c core/rtc.c core/io.c
OBJECTS = $(patsubst core/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check wasm clean
# Resource and resident RAM boundaries; not a bootable machine or complete MMU.
all: $(BUILD)/libvm.a

$(BUILD)/vm.wasm: core/clock.c core/pit.c core/io.c include/vm/clock.h include/vm/pit.h include/vm/io.h ../machine-abi/include/machine/io.h
$(BUILD)/vm.wasm: core/debug.c include/vm/debug.h
$(BUILD)/vm.wasm: core/pic.c include/vm/pic.h
$(BUILD)/vm.wasm: core/rtc.c include/vm/rtc.h

# The provider shares ordinary machine memory with generated functions. It has
# no WASI, source-decoder or JavaScript instruction/byte callback imports.
wasm: $(BUILD)/vm.wasm

$(BUILD)/vm.wasm: wasm/entry.c core/memory.c core/mmu.c core/boot.c core/supply.c include/vm/supply.h core/execution.c core/segments.c core/tables.c core/control.c core/registers.c core/msr.c include/vm/msr.h ../machine-abi/include/machine/msr.h core/exception.c include/vm/exception.h core/source.c include/vm/source.h core/memory-internal.h core/segments-internal.h \
	include/vm/memory.h include/vm/mmu.h include/vm/boot.h include/vm/execution.h ../support/include/support/types.h \
	../machine-abi/include/machine/state.h ../machine-abi/include/machine/memory.h \
	include/vm/segments.h include/vm/tables.h include/vm/control.h include/vm/registers.h ../machine-abi/include/machine/segments.h \
	../machine-abi/include/machine/result.h ../machine-abi/include/machine/entry.h | $(BUILD)
	$(WASM_CC) $(WASM_FLAGS) $(WARN) $(INCLUDES) wasm/entry.c core/memory.c core/mmu.c core/boot.c core/supply.c core/execution.c core/segments.c core/tables.c core/control.c core/registers.c core/msr.c core/debug.c core/exception.c core/source.c core/clock.c core/pit.c core/pic.c core/rtc.c core/io.c -o $@

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

$(BUILD)/page-index-check: check/page-index.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/supply-check: check/supply.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/mmu-check: check/mmu.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/tables-check: check/tables.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: tables-check
check: tables-check
tables-check: $(BUILD)/tables-check
	$(BUILD)/tables-check

$(BUILD)/boot-check: check/boot.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/rom-check: check/rom.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/execution-check: check/execution.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/segments-check: check/segments.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/system-segments-check: check/system-segments.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: system-segments-check
check: system-segments-check
system-segments-check: $(BUILD)/system-segments-check
	$(BUILD)/system-segments-check

$(BUILD)/registers-check: check/registers.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -I../x86/include $< $(BUILD)/libvm.a -o $@

$(BUILD)/exception-check: check/exception.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/source-check: check/source.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/msr-check: check/msr.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/debug-check: check/debug.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: debug-check
check: debug-check
debug-check: $(BUILD)/debug-check
	$(BUILD)/debug-check

$(BUILD)/io-check: check/io.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/pic-check: check/pic.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/rtc-check: check/rtc.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

check: $(BUILD)/io-check $(BUILD)/pic-check $(BUILD)/rtc-check

check: all $(BUILD)/resource-check $(BUILD)/memory-check $(BUILD)/page-index-check $(BUILD)/supply-check $(BUILD)/mmu-check $(BUILD)/boot-check $(BUILD)/rom-check $(BUILD)/execution-check $(BUILD)/segments-check $(BUILD)/registers-check $(BUILD)/exception-check $(BUILD)/source-check $(BUILD)/msr-check
	$(BUILD)/resource-check
	$(BUILD)/memory-check
	$(BUILD)/page-index-check
	$(BUILD)/supply-check
	$(BUILD)/mmu-check
	$(BUILD)/boot-check
	$(BUILD)/rom-check
	$(BUILD)/execution-check
	$(BUILD)/segments-check
	$(BUILD)/registers-check
	$(BUILD)/exception-check
	$(BUILD)/source-check
	$(BUILD)/msr-check
	$(BUILD)/io-check
	$(BUILD)/pic-check
	$(BUILD)/rtc-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|wasm-compiler)/|Pyodide|Python|STEP' include core

clean:
	rm -rf $(BUILD)

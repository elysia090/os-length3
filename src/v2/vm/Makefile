CC ?= cc
AR ?= ar
.DEFAULT_GOAL := all
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include -I../machine-abi/include -I../artifact/include
BUILD ?= build
WASM_OUTPUT ?= $(BUILD)/vm.wasm
WASM_CC ?= clang
WASM_PROFILE ?= 0
WASM_FLAGS = --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib \
	-Wl,--no-entry,--strip-all -Xlinker --import-memory=machine,memory \
	-Wl,--export=vm_arena_min,--export=vm_open,--export=vm_close,--export=vm_bind_state,--export=vm_access
WASM_FLAGS += -Wl,--export=vm_boot_prepare,--export=vm_boot_project,--export=vm_boot_initial_state
WASM_FLAGS += -Wl,--export=vm_boot_image
WASM_FLAGS += -Wl,--export-table,--growable-table,--export=vm_slot_min,--export=vm_bind_execution,--export=vm_run,--export=vm_completed,--export=vm_source_retired
WASM_FLAGS += -Wl,--export=vm_boot_initial_segments,--export=vm_bind_segments,--export=vm_segment
WASM_FLAGS += -Wl,--export=vm_reserve,--export=vm_commit,--export=vm_abort,--export=vm_table,--export=vm_return
WASM_FLAGS += -Wl,--export=vm_reserve_pair,--export=vm_commit_pair
WASM_FLAGS += -Wl,--export=vm_read_pair
WASM_FLAGS += -Wl,--export=vm_descriptor
WASM_FLAGS += -Wl,--export=vm_transfer
WASM_FLAGS += -Wl,--export=vm_read_extent
WASM_FLAGS += -Wl,--export=vm_write_begin,--export=vm_write_word,--export=vm_write_end
WASM_FLAGS += -Wl,--export=vm_control,--export=vm_code,--export=vm_grow,--export=vm_page_prepare,--export=vm_page_commit,--export=vm_page_count
WASM_FLAGS += -Wl,--export=vm_fault,--export=vm_iret,--export=vm_msr
WASM_FLAGS += -Wl,--export=vm_software_interrupt
WASM_FLAGS += -Wl,--export=vm_system
WASM_FLAGS += -Wl,--export=vm_debug
WASM_FLAGS += -Wl,--export=vm_flag,--export=vm_boundary
WASM_FLAGS += -Wl,--export=vm_halted
WASM_FLAGS += -Wl,--export=vm_io,--export=vm_time,--export=vm_clock_commit,--export=vm_rtc_start,--export=vm_console_commit
WASM_FLAGS += -Wl,--export=vm_post_read
WASM_FLAGS += -Wl,--export=vm_clock_poll
WASM_FLAGS += -Wl,--export=vm_console_receive
WASM_FLAGS += -Wl,--export=vm_idle_clock
WASM_FLAGS += -Wl,--export=vm_source_query,--export=vm_source_extend,--export=vm_source_publish,--export=vm_sources_reset
WASM_FLAGS += -Wl,--export=vm_source_versions_start,--export=vm_source_stamp
WASM_FLAGS += -Wl,--export=vm_source_capacity,--export=vm_source_metadata_bytes
WASM_FLAGS += -Wl,--export=vm_entry_abi
WASM_FLAGS += -Wl,--export=vm_source_demands,--export=vm_source_admissions,--export=vm_run_interrupted
WASM_FLAGS += -Wl,--export=vm_source_demand_banks,--export=vm_source_demand_word
WASM_FLAGS += -Wl,--export=vm_run_source
WASM_FLAGS += -Wl,--export=vm_directory_bind,--export=vm_directory_query,--export=vm_directory_request
WASM_FLAGS += -Wl,--export=vm_directory_node_commit,--export=vm_directory_object_commit
WASM_FLAGS += -Wl,--export=vm_directory_cancel_request,--export=vm_directory_status
WASM_FLAGS += -Wl,--export=vm_directory_module_plan,--export=vm_directory_source_publish
WASM_FLAGS += -Wl,--export=vm_directory_image_source_bind,--export=vm_directory_image_plan,--export=vm_directory_image_publish
WASM_FLAGS += -Wl,--export=vm_directory_image_select
WASM_FLAGS += -Wl,--export=vm_floating_wait
WASM_FLAGS += -Wl,--export=vm_checkpoint
ifeq ($(WASM_PROFILE),1)
WASM_FLAGS += -DVM_SOURCE_PROFILE -Wl,--export=vm_source_profile,--export=vm_system_profile,--export=vm_system_profile_path,--export=vm_system_path_word
endif
SOURCES = core/resource.c core/memory.c core/mmu.c core/boot.c core/supply.c core/execution.c core/segments.c core/tables.c core/control.c core/registers.c core/msr.c core/debug.c core/exception.c core/interrupt.c core/source.c core/clock.c core/pit.c core/pic.c core/rtc.c core/uart.c core/console.c core/io.c
SOURCES += core/system.c
SOURCES += core/source-banks.c
SOURCES += core/descriptor.c
SOURCES += core/transfer.c
SOURCES += core/directory.c
SOURCES += core/module.c
include ../artifact/sources.mk
ARTIFACT_PROVIDER_SOURCES = $(addprefix ../artifact/,$(ARTIFACT_INDEX_SOURCES)) ../support/src/sha256.c
WASM_SOURCES = wasm/entry.c $(SOURCES) $(ARTIFACT_PROVIDER_SOURCES)
OBJECTS = $(patsubst core/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check wasm clean
.PHONY: source-banks-check
check: source-banks-check
source-banks-check: $(BUILD)/source-banks-check
	$(BUILD)/source-banks-check
$(BUILD)/source-banks-check: check/source-banks.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
.PHONY: far-transfer-check
check: far-transfer-check
far-transfer-check: $(BUILD)/far-transfer-check
	$(BUILD)/far-transfer-check
$(BUILD)/far-transfer-check: check/far-transfer.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
.PHONY: descriptor-query-check
check: descriptor-query-check
descriptor-query-check: $(BUILD)/descriptor-query-check
	$(BUILD)/descriptor-query-check
$(BUILD)/descriptor-query-check: check/descriptor-query.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
.PHONY: return-widths-check
check: return-widths-check
return-widths-check: $(BUILD)/return-widths-check
	$(BUILD)/return-widths-check
$(BUILD)/return-widths-check: check/return-widths.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
.PHONY: checkpoint-check
check: checkpoint-check
checkpoint-check: $(BUILD)/checkpoint-check
	$(BUILD)/checkpoint-check
$(BUILD)/checkpoint-check: check/checkpoint.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
.PHONY: checkpoint-sanitizer-check
checkpoint-sanitizer-check: $(BUILD)/checkpoint-sanitizer-check
	$(BUILD)/checkpoint-sanitizer-check
$(BUILD)/checkpoint-sanitizer-check: check/checkpoint.c core/execution.c | $(BUILD)
	$(CC) -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all $(WARN) $(INCLUDES) $^ -o $@
.PHONY: system-check
.PHONY: directory-check
.PHONY: artifact-dependency directory-sanitizer-check
artifact-dependency:
	$(MAKE) -C ../artifact build/libartifact.a
check: directory-check
directory-check: $(BUILD)/directory-check
	$(BUILD)/directory-check
../artifact/build/libartifact.a: | artifact-dependency
$(BUILD)/directory-check: check/directory.c $(BUILD)/libvm.a ../artifact/build/libartifact.a ../support/build/libsupport.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a ../artifact/build/libartifact.a ../support/build/libsupport.a -o $@
directory-sanitizer-check: $(BUILD)/directory-sanitizer-check
	$(BUILD)/directory-sanitizer-check
$(BUILD)/directory-sanitizer-check: check/directory.c core/directory.c $(ARTIFACT_PROVIDER_SOURCES) \
	include/vm/directory.h ../artifact/include/artifact/resource.h | $(BUILD)
	$(CC) -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all \
		$(WARN) $(INCLUDES) check/directory.c core/directory.c $(ARTIFACT_PROVIDER_SOURCES) -o $@
.PHONY: segment-address-check
check: segment-address-check
segment-address-check: $(BUILD)/segment-address-check
	$(BUILD)/segment-address-check
$(BUILD)/segment-address-check: check/segment-address.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
check: system-check
system-check: $(BUILD)/system-check
	$(BUILD)/system-check
$(BUILD)/system-check: check/system.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
# Resource and resident RAM boundaries; not a bootable machine or complete MMU.
all: $(BUILD)/libvm.a

$(WASM_OUTPUT): core/clock.c core/pit.c core/io.c include/vm/clock.h include/vm/pit.h include/vm/io.h ../machine-abi/include/machine/io.h
$(WASM_OUTPUT): core/debug.c include/vm/debug.h
$(WASM_OUTPUT): core/pic.c include/vm/pic.h
$(WASM_OUTPUT): core/rtc.c include/vm/rtc.h
$(WASM_OUTPUT): core/uart.c include/vm/uart.h
$(WASM_OUTPUT): core/console.c include/vm/console.h
$(WASM_OUTPUT): core/interrupt.c include/vm/interrupt.h
$(WASM_OUTPUT): core/system.c include/vm/system.h ../machine-abi/include/machine/system.h
$(WASM_OUTPUT): ../machine-abi/include/machine/module.h

# The provider shares ordinary machine memory with generated functions. It has
# no WASI, source-decoder or JavaScript instruction/byte callback imports.
wasm: $(WASM_OUTPUT)
$(WASM_OUTPUT): $(WASM_SOURCES) $(wildcard core/*.h) Makefile ../artifact/sources.mk \
	$(wildcard ../artifact/include/artifact/*.h ../support/include/support/*.h include/vm/*.h)

$(WASM_OUTPUT): wasm/entry.c core/memory.c core/mmu.c core/boot.c core/supply.c include/vm/supply.h core/execution.c core/segments.c core/tables.c core/control.c core/registers.c core/msr.c include/vm/msr.h ../machine-abi/include/machine/msr.h core/exception.c include/vm/exception.h core/source.c include/vm/source.h core/memory-internal.h core/segments-internal.h \
	include/vm/memory.h include/vm/mmu.h include/vm/boot.h include/vm/execution.h ../support/include/support/types.h \
	../machine-abi/include/machine/state.h ../machine-abi/include/machine/memory.h \
	include/vm/segments.h include/vm/tables.h include/vm/control.h include/vm/registers.h ../machine-abi/include/machine/segments.h \
	../machine-abi/include/machine/result.h ../machine-abi/include/machine/entry.h | $(BUILD)
	$(WASM_CC) $(WASM_FLAGS) $(WARN) $(INCLUDES) $(WASM_SOURCES) -o $@

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

$(BUILD)/write-extent-check: check/write-extent.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: write-extent-check
.PHONY: read-extent-check
check: read-extent-check
read-extent-check: $(BUILD)/read-extent-check
	$(BUILD)/read-extent-check
$(BUILD)/read-extent-check: check/read-extent.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@
check: write-extent-check
write-extent-check: $(BUILD)/write-extent-check
	$(BUILD)/write-extent-check

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

$(BUILD)/boot-image-check: check/boot-image.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: boot-image-check
check: boot-image-check
boot-image-check: $(BUILD)/boot-image-check
	$(BUILD)/boot-image-check

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

$(BUILD)/interrupt-return-check: check/interrupt-return.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: interrupt-return-check
check: interrupt-return-check
interrupt-return-check: $(BUILD)/interrupt-return-check
	$(BUILD)/interrupt-return-check

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

$(BUILD)/clock-check: check/clock.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

.PHONY: clock-check
.PHONY: device-sanitizer-check
device-sanitizer-check:
	bash check/sanitizers.sh
check: clock-check
clock-check: $(BUILD)/clock-check
	$(BUILD)/clock-check

$(BUILD)/pic-check: check/pic.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/pit-check: check/pit.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/rtc-check: check/rtc.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/interrupt-check: check/interrupt.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/uart-check: check/uart.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

$(BUILD)/console-check: check/console.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

check: $(BUILD)/io-check $(BUILD)/pic-check $(BUILD)/pit-check $(BUILD)/rtc-check $(BUILD)/interrupt-check $(BUILD)/uart-check $(BUILD)/console-check

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
	$(BUILD)/pit-check
	$(BUILD)/rtc-check
	$(BUILD)/interrupt-check
	$(BUILD)/uart-check
	$(BUILD)/console-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|wasm-compiler)/|Pyodide|Python|STEP' include core

clean:
	rm -rf $(BUILD)

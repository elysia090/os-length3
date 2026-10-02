CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include -I../machine-abi/include
BUILD ?= build
SOURCES = core/resource.c core/memory.c
OBJECTS = $(patsubst core/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check clean
# Resource and resident RAM boundaries; not a bootable machine or complete MMU.
all: $(BUILD)/libvm.a

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

check: all $(BUILD)/resource-check $(BUILD)/memory-check
	$(BUILD)/resource-check
	$(BUILD)/memory-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|wasm-compiler)/|Pyodide|Python|STEP' include core

clean:
	rm -rf $(BUILD)

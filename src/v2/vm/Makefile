CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iinclude -I../support/include
BUILD ?= build
SOURCES = core/resource.c
OBJECTS = $(patsubst core/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check clean
# This library supplies resource policy, not a bootable machine or Wasm backend.
all: $(BUILD)/libvm.a

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: core/%.c include/vm/resource.h | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -ffreestanding -c $< -o $@

$(BUILD)/libvm.a: $(OBJECTS)
	$(AR) rcs $@ $^

$(BUILD)/resource-check: check/resource.c $(BUILD)/libvm.a
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libvm.a -o $@

check: all $(BUILD)/resource-check
	$(BUILD)/resource-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|wasm-compiler)/|Pyodide|Python|STEP' include core

clean:
	rm -rf $(BUILD)

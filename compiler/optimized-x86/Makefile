CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BUILD ?= build
INCLUDES = -Iinclude -I../support/include
SOURCES = src/proof.c src/reader.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
LIBRARY = $(BUILD)/liboptimized-x86.a
PROGRAM = $(BUILD)/postlink-verify

.PHONY: all library check clean dependencies
all: $(LIBRARY) $(PROGRAM)
library: $(LIBRARY)

dependencies:
	$(MAKE) -C ../support all

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -ffreestanding -c $< -o $@

$(LIBRARY): $(OBJECTS)
	$(AR) rcs $@ $^

$(PROGRAM): cli/main.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/main.c $(LIBRARY) \
		../support/build/libsupport.a -o $@

check: all
	@! grep -REn '#include <(x86|postlink|machine|wasm-compiler|artifact|storage|vm)/' include src
	@! grep -REn 'postlink\.program|OX_PROGRAM|ox_program' include src cli

clean:
	rm -rf $(BUILD)

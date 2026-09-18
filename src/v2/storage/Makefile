CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BUILD ?= build
INCLUDES = -Iinclude -I../support/include
SOURCES = src/identity.c src/delivery.c src/compression.c src/crypto.c \
	src/erasure.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check clean
all: $(BUILD)/libstorage.a

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -ffreestanding -c $< -o $@

$(BUILD)/libstorage.a: $(OBJECTS)
	$(AR) rcs $@ $^

check: all
	@! grep -REn '#include <(x86|optimized-x86|postlink|machine|wasm-compiler|artifact|vm)/' include src

clean:
	rm -rf $(BUILD)

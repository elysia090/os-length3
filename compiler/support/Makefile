CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BUILD ?= build
SOURCES = src/arena.c src/sha256.c src/future.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))

.PHONY: all check future-check arena-check clean
all: $(BUILD)/libsupport.a

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) -Iinclude -ffreestanding -c $< -o $@

$(BUILD)/libsupport.a: $(OBJECTS)
	rm -f $@
	$(AR) rcs $@ $^

$(BUILD)/future-check: check/future.c $(BUILD)/libsupport.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) -Iinclude check/future.c \
		$(BUILD)/libsupport.a -o $@

future-check: $(BUILD)/future-check
	$(BUILD)/future-check

$(BUILD)/arena-check: check/arena.c $(BUILD)/libsupport.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) -Iinclude $< $(BUILD)/libsupport.a -o $@

arena-check: $(BUILD)/arena-check
	$(BUILD)/arena-check

check: all future-check arena-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|machine|wasm-compiler|artifact|storage|vm)/' include src

clean:
	rm -rf $(BUILD)

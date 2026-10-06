CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BUILD ?= build
ZYDIS = third_party/zydis
INCLUDES = -Iinclude -I../support/include -I$(ZYDIS)/include \
	-I$(ZYDIS)/dependencies/zycore/include -I$(ZYDIS)/src
DEFINES = -DZYDIS_STATIC_BUILD -DZYDIS_DISABLE_ENCODER \
	-DZYDIS_DISABLE_FORMATTER -DZYDIS_DISABLE_SEGMENT -DZYDIS_DISABLE_KNC
SOURCES = src/elf.c src/decode.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
ZYDIS_SOURCES = Register SharedData DecoderData Decoder Mnemonic
ZYDIS_OBJECTS = $(patsubst %,$(BUILD)/zydis/%.o,$(ZYDIS_SOURCES))

.PHONY: all check clean
all: $(BUILD)/libx86.a

$(BUILD) $(BUILD)/zydis:
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(DEFINES) -MMD -MP -ffreestanding -c $< -o $@

# Also covers an incremental checkout whose objects predate dependency files.
$(BUILD)/decode.o: include/x86/profile.h
-include $(OBJECTS:.o=.d)

$(BUILD)/zydis/%.o: $(ZYDIS)/src/%.c | $(BUILD)/zydis
	$(CC) $(CFLAGS) $(INCLUDES) $(DEFINES) -ffreestanding \
		-ffunction-sections -fdata-sections -c $< -o $@

$(BUILD)/libx86.a: $(OBJECTS) $(ZYDIS_OBJECTS)
	$(AR) rcs $@ $^

$(BUILD)/profile-check: check/profile.c include/x86/profile.h | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< -o $@

$(BUILD)/kernel-profile-check: check/kernel-profile.c include/x86/profile.h | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< -o $@

$(BUILD)/decode-profile-check: check/decode-profile.c $(BUILD)/libx86.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(DEFINES) $< \
		$(BUILD)/libx86.a ../support/build/libsupport.a -o $@

$(BUILD)/code-map-check: check/code-map.c $(BUILD)/libx86.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(DEFINES) $< \
		$(BUILD)/libx86.a ../support/build/libsupport.a -o $@

$(BUILD)/relocation-check: check/relocations.c $(BUILD)/libx86.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(DEFINES) $< \
		$(BUILD)/libx86.a ../support/build/libsupport.a -o $@

$(BUILD)/transfer-check: check/transfer.c $(BUILD)/libx86.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(DEFINES) $< \
		$(BUILD)/libx86.a ../support/build/libsupport.a -o $@

$(BUILD)/locked-bit-check: check/locked-bit.c $(BUILD)/libx86.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(DEFINES) $< \
		$(BUILD)/libx86.a ../support/build/libsupport.a -o $@
.PHONY: locked-bit-check
check: locked-bit-check
locked-bit-check: $(BUILD)/locked-bit-check
	$(BUILD)/locked-bit-check

check: all $(BUILD)/profile-check $(BUILD)/kernel-profile-check $(BUILD)/decode-profile-check $(BUILD)/code-map-check \
	$(BUILD)/relocation-check $(BUILD)/transfer-check
	$(BUILD)/profile-check
	$(BUILD)/kernel-profile-check
	$(BUILD)/decode-profile-check
	$(BUILD)/code-map-check
	$(BUILD)/relocation-check
	$(BUILD)/transfer-check
	@! grep -REn '#include <(optimized-x86|postlink|machine|wasm-compiler|artifact|storage|vm)/' include src

clean:
	rm -rf $(BUILD)

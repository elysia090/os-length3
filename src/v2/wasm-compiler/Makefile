CC ?= cc
AR ?= ar
.DEFAULT_GOAL := all
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
	src/emit-cut.c src/lower-register.c src/lower-multiply.c src/lower-summary.c src/lower-divide.c src/lower-shift.c src/lower-memory.c src/lower-stack.c src/lower-system.c src/lower-io.c src/lower-repeat.c src/lower-branch.c
SOURCES += src/lower-paired-exchange.c
SOURCES += src/lower-fxsave.c

.PHONY: software-interrupt-check
check: software-interrupt-check
software-interrupt-check: $(BUILD)/software-interrupt-check
	$(BUILD)/software-interrupt-check
$(BUILD)/software-interrupt-check: check/software-interrupt.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: fxsave-check
check: fxsave-check
fxsave-check: $(BUILD)/fxsave-check $(BUILD)/fxsave-observe
	$(BUILD)/fxsave-check
	$(BUILD)/fxsave-observe

$(BUILD)/fxsave-check: check/fxsave.c check/native-fxsave.S check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -mno-red-zone check/fxsave.c check/native-fxsave.S check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/fxsave-observe: check/fxsave-observe.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) -mno-red-zone $< -o $@
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
PROVIDER_LIBRARIES = ../optimized-x86/build/liboptimized-x86.a \
	../x86/build/libx86.a ../support/build/libsupport.a

.PHONY: all wasm check fixture-tools cut-check cut-fixture-check shift-fixture-check selector-fixture-check condition-fixture-check cmov-fixture-check bit-fixture-check carry-fixture-check multiply-fixture-check summary-fixture-check memory-cmov-fixture-check memory-fixture-check stack-fixture-check repeat-fixture-check accepted-input-check projection-check clean
all: $(BUILD)/libwasm-compiler.a $(BUILD)/wasm-compiler

# Independent cold compiler memory/stack; never the VM's runtime decoder.
ZYDIS = ../x86/third_party/zydis
COLD_SOURCES = wasm/entry.c wasm/memory.c $(filter-out src/emit-module.c src/emit-dispatch.c,$(SOURCES)) \
	../x86/src/elf.c ../x86/src/decode.c ../optimized-x86/src/proof.c \
	../optimized-x86/src/reader.c ../support/src/sha256.c \
	$(addprefix $(ZYDIS)/src/,$(addsuffix .c,Register SharedData DecoderData Decoder Mnemonic))
wasm: $(BUILD)/wasm-compiler.wasm
$(BUILD)/wasm-compiler.wasm: $(COLD_SOURCES) $(wildcard include/wasm-compiler/*.h src/*.h \
	../machine-abi/include/machine/*.h ../x86/include/x86/*.h \
	../optimized-x86/include/optimized-x86/*.h ../support/include/support/*.h) | $(BUILD)
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

$(BUILD)/cut-check: check/cut.c check/native-cut.S check/native-selectors.h $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/cut.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/memory-cut-check: check/memory-cut.c check/native-cut.S check/native-selectors.h $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
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

$(BUILD)/invalidate-check: check/invalidate.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/io-check: check/io.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/table-check: check/table.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/system-segments-check: check/system-segments.c $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: system-segments-check
check: system-segments-check
system-segments-check: $(BUILD)/system-segments-check
	$(BUILD)/system-segments-check

check: table-check
.PHONY: table-check
table-check: $(BUILD)/table-check
	$(BUILD)/table-check

check: $(BUILD)/io-check

$(BUILD)/flags-check: check/flags.c check/native-flags.S | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) check/flags.c check/native-flags.S -o $@

$(BUILD)/repeat-check: check/repeat.c check/native-repeat.S check/native-cut.S | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/repeat.c check/native-repeat.S check/native-cut.S -o $@

$(BUILD)/branch-check: check/branch.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/branch.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/call-check: check/call.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/call.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/leave-check: check/leave.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/leave.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/pop-memory-check: check/pop-memory.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/pop-memory.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/push-memory-check: check/push-memory.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/push-memory.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: push-memory-check
push-memory-check: $(BUILD)/push-memory-check
	$(BUILD)/push-memory-check

$(BUILD)/memory-shift-check: check/memory-shift.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/memory-shift.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: memory-shift-check
check: memory-shift-check
memory-shift-check: $(BUILD)/memory-shift-check
	$(BUILD)/memory-shift-check

$(BUILD)/extend-check: check/extend.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/extend.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/byte-swap-check: check/byte-swap.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/byte-swap.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: byte-swap-check
check: byte-swap-check
byte-swap-check: $(BUILD)/byte-swap-check
	$(BUILD)/byte-swap-check

$(BUILD)/x87-init-check: check/x87-init.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -mno-red-zone check/x87-init.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: x87-init-check
check: x87-init-check
x87-init-check: $(BUILD)/x87-init-check
	$(BUILD)/x87-init-check

$(BUILD)/divide-check: check/divide.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/divide.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

$(BUILD)/implicit-multiply-check: check/implicit-multiply.c check/native-cut.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/implicit-multiply.c check/native-cut.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

check: $(BUILD)/implicit-multiply-check

$(BUILD)/memory-divide-check: check/memory-divide.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/memory-divide.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

check: $(BUILD)/memory-divide-check

$(BUILD)/paired-exchange-check: check/paired-exchange.c check/native-stack.S $(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -fPIE -pie check/paired-exchange.c check/native-stack.S \
		$(BUILD)/libwasm-compiler.a $(PROVIDER_LIBRARIES) -o $@

.PHONY: paired-exchange-check
check: paired-exchange-check
paired-exchange-check: $(BUILD)/paired-exchange-check
	$(BUILD)/paired-exchange-check

.PHONY: paired-exchange-fixture-check
check: paired-exchange-fixture-check
paired-exchange-fixture-check: all $(BUILD)/paired-exchange-check fixture-tools
	@task_output=$$(mktemp -d); rmdir "$$task_output"; \
		bash ../../../data/oracle/prepare-paired-exchange-cuts.sh "$$task_output" --built

.PHONY: memory-transfer-fixture-check
check: memory-transfer-fixture-check
memory-transfer-fixture-check: all $(BUILD)/memory-cut-check fixture-tools
	@task_output=$$(mktemp -d); rmdir "$$task_output"; \
		bash ../../../data/oracle/prepare-memory-transfer-cuts.sh "$$task_output" --built

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
	for rank in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DSHIFT_CASE=$$rank check/shift-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done

selector-fixture-check: $(BUILD)/cut-check $(BUILD)/memory-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for segment in 0 1 2 3 4 5; do for width in 16 32 64; do for extended in 0 1; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DSELECTOR_RANK=$$segment -DSELECTOR_WIDTH=$$width -DSELECTOR_EXTENDED=$$extended \
		check/selector-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done; done; done; \
	for segment in 0 1 2 3 4 5; do for prefix in 0 1 2; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs -DSELECTOR_MEMORY=1 \
		-DSELECTOR_RANK=$$segment -DSELECTOR_PREFIX=$$prefix \
		check/selector-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/memory-cut-check "$$scratch/optimized.elf" "$$scratch/memory"; \
	done; done

condition-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 1 2 3 4 5 6; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCONDITION_CASE=$$rank check/condition-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done

cmov-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for opcode in cmovo cmovno cmovb cmovae cmove cmovne cmovbe cmova cmovs cmovns cmovp cmovnp cmovl cmovge cmovle cmovg; do \
	for width in 16 32 64; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCUT_CMOV=$$opcode -DCUT_WIDTH=$$width check/cut-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done; done

bit-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for opcode in bt bts btr btc; do for width in 16 32 64; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCUT_BIT=$$opcode -DCUT_WIDTH=$$width -DCUT_BIT_CASE=4 check/cut-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done; done

carry-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for opcode in adc sbb; do for width in 8 16 32 64; do \
	for rank in 0 1 2 5 6 7 8; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCUT_CARRY=$$opcode -DCUT_WIDTH=$$width -DCUT_CARRY_CASE=$$rank check/cut-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done; done; done

memory-carry-fixture-check: $(BUILD)/memory-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for opcode in adc sbb; do for width in 8 16 32 64; do for rank in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17; do \
	if [ $$width != 8 ] && { [ $$rank = 12 ] || [ $$rank = 13 ]; }; then continue; fi; \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DMEMORY_CARRY=$$opcode -DMEMORY_WIDTH=$$width -DMEMORY_CARRY_CASE=$$rank \
		check/memory-carry-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/memory-cut-check "$$scratch/optimized.elf" "$$scratch/memory"; \
	done; done; done

.PHONY: memory-carry-fixture-check
check: memory-carry-fixture-check

memory-cmov-fixture-check: $(BUILD)/memory-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for opcode in cmovo cmovno cmovb cmovae cmove cmovne cmovbe cmova cmovs cmovns cmovp cmovnp cmovl cmovge cmovle cmovg; do \
	for width in 16 32 64; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DMEMORY_CMOV=$$opcode -DMEMORY_WIDTH=$$width check/memory-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/memory-cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done; done

memory-fixture-check: $(BUILD)/memory-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for rank in 0 20 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 \
		62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 \
		89 90 91 92 93 94 95 96 97 98 99 100 101 102 103 104 105 106 \
		107 108 109 110 111 112 113 114 115 116 117 118 119 120 121 122 123 124 125 126 127 128 \
		129 130 131 132 133 134 135 136 137 138 139 140 141 142 143 144 145 146 147 148 \
		149 150 151 152 153 154 155 156 157 158 159 160 \
		161 162 163 164 165 166 167 168 169 170 171 172 173 174 175 176 177 178 179 180 181 182 183 184 185 \
		186 187 188 189 190 191 192 193 194 195 196 197 198 199 200 201 202 203 204 205 206 207 208 209 \
		210 211 212 213 214 215 216 217 218 219 220 221 222 223 \
		224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 \
		246 247 248 249 250 251 252 253 254 255 256 257 258 259 260 261 262 263 264 265 266 267 \
		268 269 270 271 272 273 274 275 276 277 278 279 280 \
		281 282 283 284 285 286 287 288 289 290 291 292 293 294 295 296 297 298 299 300 301 302 303 \
		304 305 306 307 308 309 310 311 312 313 314 315 316 317 318 319 320 321 322 323 324 325 326; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DMEMORY_CASE=$$rank check/memory-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	if [ $$rank = 22 ] || [ $$rank = 45 ] || [ $$rank = 88 ]; then \
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

repeat-fixture-check: $(BUILD)/repeat-check
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	$(BUILD)/repeat-check "$$scratch/native.bin" "$$scratch/fault.bin" "$$scratch/stos-native.bin" "$$scratch/stos-fault.bin"

multiply-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for width in 16 32 64; do for rank in 0 2 3 5 8 10; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DCUT_MULTIPLY=1 -DCUT_WIDTH=$$width -DCUT_MULTIPLY_CASE=$$rank check/cut-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut"; \
	done; done

summary-fixture-check: $(BUILD)/cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	for kind in 0 1 2 3 4; do for width in 16 32 64; do for rank in 0 1 2 3 4; do \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		-DSUMMARY_KIND=$$kind -DSUMMARY_WIDTH=$$width -DSUMMARY_CASE=$$rank \
		check/summary-fixture.S -o "$$scratch/linked.elf"; \
	../postlink-compiler/build/postlink-compiler "$$scratch/linked.elf" -o "$$scratch/optimized.elf"; \
	../optimized-x86/build/postlink-verify "$$scratch/linked.elf" "$$scratch/optimized.elf"; \
	limit=64; if [ $$rank = 2 ]; then limit=1; fi; \
	$(BUILD)/cut-check "$$scratch/optimized.elf" "$$scratch/cut" $$limit; \
	done; done; done

.PHONY: memory-summary-fixture-check
check: memory-summary-fixture-check
memory-summary-fixture-check: $(BUILD)/memory-cut-check fixture-tools
	@set -eu; scratch=$$(mktemp -d); trap 'rm -rf "$$scratch"' EXIT; \
	bash ../../../data/oracle/prepare-memory-summary-cuts.sh "$$scratch/records" --built

check: all $(BUILD)/admission-check cut-fixture-check shift-fixture-check selector-fixture-check condition-fixture-check cmov-fixture-check bit-fixture-check carry-fixture-check multiply-fixture-check summary-fixture-check memory-cmov-fixture-check memory-fixture-check stack-fixture-check repeat-fixture-check $(BUILD)/branch-check $(BUILD)/call-check $(BUILD)/leave-check $(BUILD)/extend-check $(BUILD)/divide-check $(BUILD)/fetch-cut-check $(BUILD)/fetch-fixture.elf $(BUILD)/code-cut-check $(BUILD)/invalidate-check $(BUILD)/flags-check $(BUILD)/pop-memory-check $(BUILD)/push-memory-check
	$(BUILD)/admission-check
	$(BUILD)/branch-check
	$(BUILD)/call-check
	$(BUILD)/leave-check
	$(BUILD)/pop-memory-check
	$(BUILD)/push-memory-check
	$(BUILD)/extend-check
	$(BUILD)/divide-check
	$(BUILD)/implicit-multiply-check
	$(BUILD)/memory-divide-check
	$(BUILD)/fetch-cut-check $(BUILD)/fetch-fixture.elf
	$(BUILD)/code-cut-check
	$(BUILD)/invalidate-check
	$(BUILD)/io-check
	$(BUILD)/flags-check
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

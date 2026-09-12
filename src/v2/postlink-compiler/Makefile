# linked x86-64 ELF -> independently runnable optimized x86-64 ELF

CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BARE_FIXTURE_FLAGS = -nostdlib -static -Wl,-no-pie,--emit-relocs
BUILD ?= build
INCLUDES = -Iinclude -Isrc -I../support/include -I../x86/include \
	-I../optimized-x86/include
ZYDIS_INCLUDES = -I../x86/third_party/zydis/include \
	-I../x86/third_party/zydis/dependencies/zycore/include \
	-I../x86/third_party/zydis/src
SOURCES = src/compiler.c src/emit-x86.c src/layout-elf.c src/metadata.c src/relocate-elf.c src/entry.c src/table.c src/native.c src/select-x86.c src/minimum.c src/format.c src/semantic.c src/block.c src/closure.c \
	src/transfer.c src/template.c src/project.c src/plan.c src/compose.c \
	src/compact.c src/rewrite.c src/sweep.c src/region.c src/alu.c \
	src/affine.c src/quotient.c src/scalar.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
DEPENDENCIES = $(OBJECTS:.o=.d)
LIBRARY = $(BUILD)/libpostlink.a
PROGRAM = $(BUILD)/postlink-compiler

.PHONY: all library check elf-proof-check observed-compile-check relocation-free-product-check product-gate-check shared-product-gate-check runtime-elf-check modular-address-check physical-entry-check code-grid-check relative-code-pointer-check local-code-address-check observed-code-span-check mutable-code-site-check trap-continuation-check alternative-record-check linked-field-authority-check table-side-exit-check call-cut-check dispatch-alias-check profile-extension-check overlapping-control-check patch-trampoline-check mixed-load-check nonimage-control-check dynamic-runtime-check metadata-closure-check entry-check native-closure-check select-x86-check native-layout-check population-check direct-control-check scalar-check physical-check quotient-check normal-form-check global-minimum-check instruction-law-check catalog block-catalog native-benchmark distribution-population-check production-benchmark-fixture-check production-benchmark-check linked-completeness-check \
	clean dependencies
all: $(PROGRAM)
library: $(LIBRARY)

dependencies:
	$(MAKE) -C ../support all
	$(MAKE) -C ../x86 all
	$(MAKE) -C ../optimized-x86 all

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -ffreestanding -MMD -MP -c $< -o $@

-include $(DEPENDENCIES)

$(LIBRARY): $(OBJECTS)
	$(AR) rcs $@ $^

$(PROGRAM): cli/main.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/main.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

$(BUILD)/completeness: check/completeness.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/completeness.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

$(BUILD)/elf-proof: check/elf-proof.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/elf-proof.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

$(BUILD)/observed-compile: check/observed-compile.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/observed-compile.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

observed-compile-check: $(BUILD)/observed-compile
	@temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g -Wl,--emit-relocs check/elf-proof-fixture.c \
		-o "$$temporary/input"; \
	$(BUILD)/observed-compile "$$temporary/input"

$(BUILD)/catalog: check/catalog.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $(ZYDIS_INCLUDES) check/catalog.c \
		$(LIBRARY) ../x86/build/libx86.a \
		../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

$(BUILD)/scalar: check/scalar.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/scalar.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

scalar-check: $(BUILD)/scalar
	$(BUILD)/scalar

$(BUILD)/physical: check/physical.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/physical.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

physical-check: $(BUILD)/physical
	$(BUILD)/physical

$(BUILD)/quotient: check/quotient.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/quotient.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

quotient-check: $(BUILD)/quotient
	$(BUILD)/quotient

$(BUILD)/normal-form: check/normal-form.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/normal-form.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

normal-form-check: $(BUILD)/normal-form
	$(BUILD)/normal-form

$(BUILD)/global-minimum: check/global-minimum.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/global-minimum.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

global-minimum-check: $(BUILD)/global-minimum
	$(BUILD)/global-minimum

$(BUILD)/block-observation: check/block-observation.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/block-observation.c \
		$(LIBRARY) ../x86/build/libx86.a \
		../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

block-observation-check: $(BUILD)/block-observation
	$(BUILD)/block-observation

$(BUILD)/slice-observation: check/slice-observation.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/slice-observation.c \
		$(LIBRARY) ../x86/build/libx86.a \
		../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

slice-observation-check: $(BUILD)/slice-observation
	$(BUILD)/slice-observation

$(BUILD)/instruction-law: check/instruction-law.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/instruction-law.c \
		$(LIBRARY) ../x86/build/libx86.a \
		../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

instruction-law-check: $(BUILD)/instruction-law
	$(BUILD)/instruction-law

$(BUILD)/direct-control: check/direct-control.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/direct-control.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

direct-control-check: $(BUILD)/direct-control
	$(BUILD)/direct-control

$(BUILD)/block-catalog: check/block-catalog.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/block-catalog.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

block-catalog: $(BUILD)/block-catalog

$(BUILD)/native-benchmark: check/native-benchmark.c dependencies
	$(CC) $(CFLAGS) $(WARN) -I../support/include check/native-benchmark.c \
		../support/build/libsupport.a -o $@

native-benchmark: $(BUILD)/native-benchmark

distribution-population-check:
	bash ../../../data/distribution/check-measure-root.sh

production-benchmark-fixture-check: $(BUILD)/native-benchmark
	bash check/production-benchmark.sh $(BUILD)/native-benchmark

# The production comparison always consumes the repository-owned workload
# manifest. Callers select identities by supplying two complete release roots;
# they cannot weaken the sample count or replace the workload population.
production-benchmark-check: $(BUILD)/native-benchmark
	@test -n "$(SOURCE_ROOT)" || \
		{ echo "SOURCE_ROOT=/path/to/source-root is required" >&2; exit 2; }
	@test -n "$(OPTIMIZED_ROOT)" || \
		{ echo "OPTIMIZED_ROOT=/path/to/optimized-root is required" >&2; exit 2; }
	@test -n "$(BENCHMARK_REPORT)" || \
		{ echo "BENCHMARK_REPORT=/path/to/report is required" >&2; exit 2; }
	bash ../../../data/distribution/benchmark-postlink.sh \
		"$(SOURCE_ROOT)" "$(OPTIMIZED_ROOT)" \
		$(BUILD)/native-benchmark "$(BENCHMARK_REPORT)"

catalog: $(BUILD)/catalog

# Publication gate for the exact linked image selected by the caller.  It is
# intentionally not folded into the fast witness suite: no repository fixture
# can prove closure of a different Linux/toolchain generation.
linked-completeness-check: $(BUILD)/catalog
	@test -n "$(X86_IMAGE)" || \
		{ echo "X86_IMAGE=/path/to/linked.elf is required" >&2; exit 2; }
	$(BUILD)/catalog "$(X86_IMAGE)" --require-semantics

elf-proof-check: $(BUILD)/elf-proof
	@temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g check/elf-proof-fixture.c -o "$$temporary/input"; \
	$(BUILD)/elf-proof "$$temporary/input" "$$temporary/output"; \
	test $$(stat -c %s "$$temporary/output") \
		-lt $$(stat -c %s "$$temporary/input"); \
	chmod +x "$$temporary/output"; \
	"$$temporary/input"; \
	"$$temporary/output"; \
	$(CC) -O0 -g -fPIC -shared check/elf-proof-fixture.c \
		-o "$$temporary/input.so"; \
	$(BUILD)/elf-proof "$$temporary/input.so" "$$temporary/output.so"; \
	test $$(stat -c %s "$$temporary/output.so") \
		-lt $$(stat -c %s "$$temporary/input.so")

# A self-contained static ET_EXEC may have zero construction relocations and
# still emits one independently executable, proved ordinary ELF.
relocation-free-product-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -static -Wl,-no-pie,--build-id=none \
		check/relocation-free-fixture.S \
		-o "$$temporary/input-without-relocations"; \
	$(PROGRAM) "$$temporary/input-without-relocations" \
		-o "$$temporary/output-without-relocations"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input-without-relocations" \
		"$$temporary/output-without-relocations"; \
	test $$(stat -c %s "$$temporary/output-without-relocations") \
		-lt $$(stat -c %s "$$temporary/input-without-relocations"); \
	"$$temporary/input-without-relocations"; \
	"$$temporary/output-without-relocations"

# A dynamically linked input still needs retained static construction rows.
# With them, the product emits a smaller proved ELF with no post-link runtime.
product-gate-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g check/elf-proof-fixture.c \
		-o "$$temporary/dynamic-without-relocations"; \
	! $(PROGRAM) "$$temporary/dynamic-without-relocations" \
		-o "$$temporary/rejected" 2>"$$temporary/relocation-error"; \
	grep -q 'dynamic linked ELF lacks static construction relocations' \
		"$$temporary/relocation-error"; \
	$(CC) -O0 -g -Wl,--emit-relocs check/elf-proof-fixture.c \
		-o "$$temporary/input"; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	test $$(stat -c %s "$$temporary/output") \
		-lt $$(stat -c %s "$$temporary/input"); \
	"$$temporary/input"; "$$temporary/output"

# ET_DYN with e_entry == 0 is a first-class linked product.  Exported symbols
# and loader metadata close its roots; no invented process entry or DSO bypass
# is allowed.
shared-product-gate-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g -fPIC -shared -Wl,--emit-relocs \
		check/shared-object-fixture.c -o "$$temporary/input.so"; \
	$(CC) -O2 check/shared-object-consumer.c -ldl \
		-o "$$temporary/consumer"; \
	"$$temporary/consumer" "$$temporary/input.so"; \
	$(PROGRAM) "$$temporary/input.so" -o "$$temporary/output.so"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input.so" "$$temporary/output.so"; \
	test $$(stat -c %s "$$temporary/output.so") \
		-lt $$(stat -c %s "$$temporary/input.so"); \
	"$$temporary/consumer" "$$temporary/output.so"

$(BUILD)/runtime-elf-stage: check/runtime-elf-stage.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/runtime-elf-stage.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

$(BUILD)/metadata-closure: check/metadata-closure.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/metadata-closure.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

runtime-elf-check: $(BUILD)/runtime-elf-stage
	@temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/runtime-elf-fixture.S \
		-o "$$temporary/input"; \
	$(BUILD)/runtime-elf-stage "$$temporary/input" "$$temporary/output"; \
	chmod +x "$$temporary/output"; \
	set +e; "$$temporary/input"; source_status=$$?; \
	"$$temporary/output"; output_status=$$?; set -e; \
	test $$source_status -eq 42; test $$output_status -eq 42

# ELF64 relocation arithmetic is modulo 2^64.  A code symbol plus a large
# addend may deliberately leave the executable interval; the compiler must
# move the symbol and preserve the addend rather than reject unsigned wrap.
modular-address-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/modular-address-fixture.S \
		-o "$$temporary/input"; \
	"$$temporary/input"; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	"$$temporary/output"

$(BUILD)/physical-entry: check/physical-entry.c dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/physical-entry.c \
		../x86/build/libx86.a ../support/build/libsupport.a -o $@

# Bare-metal ELF may spell e_entry through p_paddr while its instruction
# coordinates use p_vaddr.  The optimized ELF must preserve that public alias.
physical-entry-check: $(PROGRAM) $(BUILD)/physical-entry
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -c check/modular-address-fixture.S -o "$$temporary/input.o"; \
	$(LD) --emit-relocs -T check/physical-entry-fixture.ld \
		"$$temporary/input.o" -o "$$temporary/input"; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	$(BUILD)/physical-entry "$$temporary/input" "$$temporary/output"

# A non-function executable symbol with an explicit extent may publish a
# bounded fixed-stride entry grid.  Moving only its base changes base+i*stride
# into a different instruction, even though ordinary direct-control closure
# and the ELF proof both appear complete.
code-grid-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/code-grid-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

relative-code-pointer-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/relative-code-pointer-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

local-code-address-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/local-code-address-fixture.S \
		-o "$$temporary/input"; \
	! readelf -rW "$$temporary/input" \
		| grep -q 'local_initializer'; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

observed-code-span-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/observed-code-span-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

mutable-code-site-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/mutable-code-site-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

trap-continuation-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/trap-continuation-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

alternative-record-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/alternative-record-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

$(BUILD)/swap-relative-fields: check/swap-relative-fields.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) check/swap-relative-fields.c -o $@

linked-field-authority-check: $(PROGRAM) $(BUILD)/swap-relative-fields
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/linked-field-authority-fixture.S \
		-o "$$temporary/input"; \
	$(BUILD)/swap-relative-fields "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

patch-trampoline-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/patch-trampoline-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

mixed-load-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -c check/mixed-load-fixture.S -o "$$temporary/input.o"; \
	$(LD) --emit-relocs -T check/mixed-load-fixture.ld \
		"$$temporary/input.o" -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

nonimage-control-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/nonimage-control-fixture.S \
		-o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --nonimage; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/input"; source_status=$$?; \
	"$$temporary/output"; output_status=$$?; set -e; \
	test $$source_status -eq 42; test $$output_status -eq 42

dynamic-runtime-check: $(BUILD)/runtime-elf-stage
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g -U_FORTIFY_SOURCE -Wl,--emit-relocs \
		check/unwind-runtime-fixture.c \
		-o "$$temporary/input"; \
	$(BUILD)/runtime-elf-stage "$$temporary/input" "$$temporary/output" \
		--dynamic; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	chmod +x "$$temporary/output"; \
	"$$temporary/input"; "$$temporary/output"

metadata-closure-check: $(BUILD)/metadata-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g -U_FORTIFY_SOURCE -Wl,--emit-relocs \
		check/unwind-runtime-fixture.c \
		-o "$$temporary/input"; \
	$(BUILD)/metadata-closure "$$temporary/input"

$(BUILD)/entry: check/entry.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/entry.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

entry-check: $(BUILD)/entry
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/relocation-source-fixture.S \
		-o "$$temporary/relocation-source"; \
	$(BUILD)/entry "$$temporary/relocation-source" \
		| grep -q '1 candidates -> 1 primary + 0 metadata entries; 0 observable addresses'; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/entry-role-fixture.S \
		-o "$$temporary/roles"; \
	$(BUILD)/entry "$$temporary/roles" \
		| grep -q '3 candidates -> 1 primary + 2 metadata entries; 2 observable addresses'; \
	$(CC) -O2 -Wl,--emit-relocs check/elf-proof-fixture.c \
		-o "$$temporary/input"; \
	$(BUILD)/entry "$$temporary/input"; \
	$(CC) -O2 -fPIC -shared -Wl,--emit-relocs \
		check/elf-proof-fixture.c -o "$$temporary/input.so"; \
	$(BUILD)/entry "$$temporary/input.so"

table-side-exit-check: $(BUILD)/entry
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/table-side-exit-fixture.S \
		-o "$$temporary/input"; \
	$(BUILD)/entry "$$temporary/input" 0 0xffffffffffffffff \
		| grep -q 'recognized table projection: 11 bases'; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42

# A direct call observes the complete architectural register state at its
# target.  In particular, a switch arm's RIP-relative load into an argument
# register cannot be erased as a prefix merely because every arm joins at the
# same direct call coordinate.
call-cut-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O2 -fPIE -pie -nostdlib \
		-Wl,--emit-relocs,--build-id=none check/call-cut-c-fixture.c \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

dispatch-alias-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/dispatch-alias-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

profile-extension-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/profile-extension-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

overlapping-control-check: $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/overlapping-control-fixture.S \
		-o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(BUILD)/native-closure "$$temporary/input"

$(BUILD)/native-closure: check/native-closure.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/native-closure.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

native-closure-check: $(BUILD)/native-closure
	@temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O2 -Wl,--emit-relocs check/elf-proof-fixture.c \
		-o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input"

$(BUILD)/select-x86: check/select-x86.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/select-x86.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

select-x86-check: $(BUILD)/select-x86
	$(BUILD)/select-x86

.PHONY: shift-width-check
$(BUILD)/shift-width: check/shift-width.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/shift-width.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

shift-width-check: $(BUILD)/shift-width
	$(BUILD)/shift-width

check: shift-width-check

.PHONY: condition-code-check
$(BUILD)/condition-code: check/condition-code.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/condition-code.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

condition-code-check: $(BUILD)/condition-code
	$(BUILD)/condition-code

check: condition-code-check

.PHONY: arithmetic-cut-check
$(BUILD)/arithmetic-cut: check/arithmetic-cut.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/arithmetic-cut.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

arithmetic-cut-check: $(BUILD)/arithmetic-cut
	$(BUILD)/arithmetic-cut

check: arithmetic-cut-check

$(BUILD)/native-layout: check/native-layout.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/native-layout.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

native-layout-check: $(BUILD)/native-layout
	$(BUILD)/native-layout

$(BUILD)/population: check/population.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/population.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

population-check: $(BUILD)/population
	$(BUILD)/population

check: $(PROGRAM) $(BUILD)/completeness elf-proof-check observed-compile-check relocation-free-product-check product-gate-check shared-product-gate-check runtime-elf-check modular-address-check physical-entry-check code-grid-check relative-code-pointer-check local-code-address-check observed-code-span-check mutable-code-site-check trap-continuation-check alternative-record-check linked-field-authority-check table-side-exit-check call-cut-check dispatch-alias-check profile-extension-check overlapping-control-check patch-trampoline-check mixed-load-check nonimage-control-check dynamic-runtime-check metadata-closure-check entry-check native-closure-check select-x86-check native-layout-check population-check direct-control-check scalar-check physical-check quotient-check normal-form-check global-minimum-check block-observation-check slice-observation-check instruction-law-check distribution-population-check production-benchmark-fixture-check
	@! grep -REn 'PL_VM_|pl_vm_|wasm-compiler|machine-artifact|delivery|worker' \
		include src cli
	$(BUILD)/completeness

clean:
	rm -rf $(BUILD)

# linked x86-64 ELF -> independently runnable optimized x86-64 ELF

CC ?= cc
AR ?= ar
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BARE_FIXTURE_FLAGS = -nostdlib -fno-stack-protector -static \
	-Wl,-no-pie,--emit-relocs
BUILD ?= build
INCLUDES = -Iinclude -Isrc -I../support/include -I../x86/include \
	-I../optimized-x86/include
ZYDIS_INCLUDES = -I../x86/third_party/zydis/include \
	-I../x86/third_party/zydis/dependencies/zycore/include \
	-I../x86/third_party/zydis/src
SOURCES = src/compiler.c src/emit-x86.c src/layout-elf.c src/metadata.c src/relocate-elf.c src/discover-entry.c src/jump-table.c src/compile-elf.c src/minimum.c src/format.c src/form-block.c src/closure.c \
	src/transfer.c src/template.c src/project.c src/plan.c \
	src/affine.c src/quotient.c src/scalar.c \
	src/selection/encoding.c src/selection/source.c src/selection/operands.c \
	src/selection/expressions.c src/selection/flags.c src/selection/select-rules.c \
	src/selection/lea.c src/selection/tree-measure.c src/selection/tree-write.c \
	src/selection/simple-frame.c src/selection/alu-frame.c \
	src/selection/arx-frame.c src/selection/carry-frame.c \
	src/selection/handoff.c src/selection/branch-frame.c \
	src/selection/state-frame.c src/selection/flag-frame.c \
	src/selection/shared-dag.c src/selection/projection.c src/selection/select.c src/selection/candidates.c
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
DEPENDENCIES = $(OBJECTS:.o=.d)
LIBRARY = $(BUILD)/libpostlink.a
PROGRAM = $(BUILD)/postlink-compiler

.PHONY: all library check elf-proof-check observed-compile-check relocation-free-product-check product-gate-check shared-product-gate-check runtime-elf-check modular-address-check physical-entry-check code-grid-check relative-code-pointer-check table-alternative-bound-check stack-slot-table-check copied-memory-table-check backward-exit-table-check backward-loop-table-check chained-table-cut-check nested-table-guards-check local-code-address-check pie-address-difference-check final-flags-after-value-check observed-code-span-check mutable-code-site-check trap-continuation-check alternative-record-check linked-field-authority-check table-side-exit-check call-cut-check dispatch-alias-check profile-extension-check overlapping-control-check patch-trampoline-check mixed-load-check nonimage-control-check dynamic-runtime-check metadata-closure-check entry-check native-closure-check select-x86-check native-layout-check population-check direct-control-check scalar-check physical-check quotient-check normal-form-check global-minimum-check instruction-law-check catalog block-catalog native-benchmark distribution-population-check production-benchmark-fixture-check production-benchmark-check linked-completeness-check \
	clean dependencies
all: $(PROGRAM)
.PHONY: boolean-entry-capture-check
.PHONY: entry-alu-capture-check
check: boolean-entry-capture-check entry-alu-capture-check
.PHONY: publication-lifetime-check
.PHONY: entry-alu-generation-check
check: entry-alu-generation-check
entry-alu-generation-check: $(BUILD)/entry-alu-generation-check
	$(BUILD)/entry-alu-generation-check
$(BUILD)/entry-alu-generation-check: check/entry-alu-generation.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -mno-red-zone $< $(LIBRARY) ../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a ../support/build/libsupport.a -o $@
check: publication-lifetime-check
publication-lifetime-check: $(BUILD)/publication-lifetime-check
	$(BUILD)/publication-lifetime-check
$(BUILD)/publication-lifetime-check: check/publication-lifetime.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) -mno-red-zone $(INCLUDES) $< $(LIBRARY) ../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a ../support/build/libsupport.a -o $@
library: $(LIBRARY)

dependencies:
	$(MAKE) -C ../support all
	$(MAKE) -C ../x86 all
	$(MAKE) -C ../optimized-x86 all

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: src/%.c | $(BUILD)
	mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -ffreestanding -MMD -MP -c $< -o $@

-include $(DEPENDENCIES)

$(LIBRARY): $(OBJECTS) Makefile
	rm -f $@.tmp
	$(AR) rcs $@.tmp $(OBJECTS)
	mv $@.tmp $@

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

$(BUILD)/linear-block: check/linear-block.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/linear-block.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

.PHONY: linear-block-check
linear-block-check: $(BUILD)/linear-block
	$(BUILD)/linear-block

check: linear-block-check

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
		../support/build/libsupport.a -o $@ -lm

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
	$(CC) -nostdlib -fno-stack-protector -static -Wl,-no-pie,--build-id=none \
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

.PHONY: table-base-reuse-after-target-check
table-base-reuse-after-target-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/table-base-reuse-after-target.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=13 '; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify "$$temporary/input" "$$temporary/output"; \
	set --; i=0; \
	while test $$i -lt 13; do \
		set +e; "$$temporary/input" "$$@"; before=$$?; \
		"$$temporary/output" "$$@"; after=$$?; set -e; \
		test $$before -eq $$((42+i)); test $$after -eq $$before; \
		set -- "$$@" argument; i=$$((i+1)); \
	done; \
	$(CC) $(BARE_FIXTURE_FLAGS) -DBREAK_TARGET=1 -Wl,--build-id=none \
		check/table-base-reuse-after-target.S -o "$$temporary/bad"; \
	if $(BUILD)/native-closure "$$temporary/bad" --list-tables \
		| grep -Eq '^table .* rows=13 '; then \
		echo 'overwritten target promoted to a relative table' >&2; exit 1; \
	fi

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

table-alternative-bound-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/table-alternative-bound.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=82 '; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	for variant in merged split large wide; do \
	variant_flags=; row_count=51; \
	case "$$variant" in split) variant_flags=-DSPLIT_EDGE;; \
		large) variant_flags=-DLARGE_FUNCTION;; \
		wide) variant_flags=-DWIDE_TABLE; row_count=301;; esac; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DNO_OUTER_GUARD check/table-alternative-bound.S \
		$$variant_flags -o "$$temporary/merged-edge"; \
	$(BUILD)/native-closure "$$temporary/merged-edge" --list-tables \
		| grep -Eq "^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=$$row_count "; \
	set +e; "$$temporary/merged-edge"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/merged-edge" -o "$$temporary/merged-output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/merged-edge" "$$temporary/merged-output"; \
	set +e; "$$temporary/merged-output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	done

stack-slot-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/stack-slot-table.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=7 '; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 10; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 10; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DBREAK_SLOT check/stack-slot-table.S -o "$$temporary/broken-slot"; \
	$(BUILD)/native-closure "$$temporary/broken-slot" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'; \
	$(call same_as_source,"$$temporary/broken-slot")

copied-memory-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/copied-memory-table.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=50 '; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DBREAK_COPY check/copied-memory-table.S -o "$$temporary/broken-copy"; \
	$(BUILD)/native-closure "$$temporary/broken-copy" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'; \
	$(call same_as_source,"$$temporary/broken-copy")

# A dispatch no proof bounds is kept as an open domain over its row run; the
# compiled program must still behave exactly like the source (each negative
# variant below used to compile to a binary that crashed or exited wrong).
define same_as_source
set +e; timeout 5 $(1) >/dev/null 2>&1; source_status=$$?; set -e; \
	$(PROGRAM) $(1) -o $(1).out >/dev/null; \
	set +e; timeout 5 $(1).out >/dev/null 2>&1; output_status=$$?; set -e; \
	test $$source_status -eq $$output_status
endef

.PHONY: affine-memory-table-check
affine-memory-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/affine-memory-table.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=5 .*closed=1$$'; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify "$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	for variant in MUTATE_INDEX MUTATE_COPY MUTATE_MEMORY BYPASS_DEFINITION; do \
	  $(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none -D$$variant \
		check/affine-memory-table.S -o "$$temporary/$$variant"; \
	  $(BUILD)/native-closure "$$temporary/$$variant" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'; \
	$(call same_as_source,"$$temporary/$$variant"); \
	done

check: affine-memory-table-check

backward-exit-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/backward-exit-table.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=32 '; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DBREAK_EXIT check/backward-exit-table.S \
		-o "$$temporary/broken-exit"; \
	$(BUILD)/native-closure "$$temporary/broken-exit" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'; \
	$(call same_as_source,"$$temporary/broken-exit")

backward-loop-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/backward-loop-table.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^table base=0x[0-9a-f]+ consumer=0x[0-9a-f]+ rows=9 '; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DBREAK_LOOP check/backward-loop-table.S \
		-o "$$temporary/broken-loop"; \
	$(BUILD)/native-closure "$$temporary/broken-loop" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'; \
	$(call same_as_source,"$$temporary/broken-loop")

chained-table-cut-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/chained-table-cut.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^tables=2 targets=12$$'; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DBREAK_CUT check/chained-table-cut.S \
		-o "$$temporary/broken-cut"; \
	$(BUILD)/native-closure "$$temporary/broken-cut" --list-tables \
		| grep -Eq '^tables=1 targets=6$$'; \
	$(call same_as_source,"$$temporary/broken-cut")

nested-table-guards-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/nested-table-guards.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^tables=2 targets=43$$'; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq ' rows=15 '; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/input"; source_status=$$?; \
	"$$temporary/output"; output_status=$$?; set -e; \
	test $$source_status -eq 42; test $$output_status -eq 42; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DALTERNATIVE_PATH check/nested-table-guards.S \
		-o "$$temporary/alternative"; \
	$(BUILD)/native-closure "$$temporary/alternative" --list-tables \
		| grep -Eq ' rows=100 '

.PHONY: closed-table-set-check interior-trampoline-check indirect-default-table-check
indirect-default-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for variant in original stale-rows; do \
	flags=; if test "$$variant" = stale-rows; then flags=-DSTALE_RELA_ROWS; fi; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		$$flags check/indirect-default-table.S -o "$$temporary/input"; \
	if test "$$variant" = stale-rows; then \
		objcopy --dump-section .rodata="$$temporary/rows" "$$temporary/input"; \
		dd if="$$temporary/rows" of="$$temporary/word" bs=4 count=1 2>/dev/null; \
		file_offset=$$(objdump -h "$$temporary/input" \
			| awk '$$2 == ".rodata" { print "0x" $$6 }'); \
		test -n "$$file_offset"; \
		dd if="$$temporary/word" of="$$temporary/input" bs=1 \
			seek=$$((file_offset + 8)) count=4 conv=notrunc 2>/dev/null; \
	fi; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		> "$$temporary/domains"; \
	grep -qx 'tables=0 targets=0' "$$temporary/domains"; \
	grep -qx 'shared-base encodings=1 retained addresses=4' "$$temporary/domains"; \
	set +e; timeout 5 "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; timeout 5 "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	done; \
	printf 'indirect default table: green (unknown control remains unproved; linked rows own relocation)\n'

check: indirect-default-table-check

.PHONY: interior-compare-table-check
interior-compare-table-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for variant in immediate displacement arithmetic; do \
	  definitions=; \
	  case $$variant in \
	    displacement) definitions=-DDISPLACEMENT_COMPARE ;; \
	    arithmetic) definitions=-DARITHMETIC_COMPARE ;; \
	  esac; \
	  $(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
	    $$definitions check/interior-compare-table.S -o "$$temporary/input"; \
	  $(BUILD)/native-closure "$$temporary/input" --list-tables \
	    | grep -Eq '^tables=1 targets=4$$'; \
	  set +e; "$$temporary/input"; source_status=$$?; set -e; \
	  test $$source_status -eq 42; \
	  $(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	  ../optimized-x86/build/postlink-verify \
	    "$$temporary/input" "$$temporary/output"; \
	  set +e; timeout 5 "$$temporary/output"; output_status=$$?; set -e; \
	  test $$output_status -eq 42; \
	done

check: interior-compare-table-check

interior-trampoline-check: $(PROGRAM) $(BUILD)/entry
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none,-Ttext=0x401000 \
		check/interior-trampoline.S -o "$$temporary/input"; \
	$(BUILD)/entry "$$temporary/input" 0x401003 0x401004 \
		> "$$temporary/entries"; \
	! grep -q '^metadata entry 0x401003 ' "$$temporary/entries"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

closed-table-set-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/closed-table-set.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^tables=2 targets=5$$'; \
	"$$temporary/input"; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	"$$temporary/output"; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		-DBYPASS_GUARD check/closed-table-set.S -o "$$temporary/bypass"; \
	$(BUILD)/native-closure "$$temporary/bypass" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'
	@# Not compared with the source: this variant indexes table A past its
	@# own rows into table B's first row, read relative to A's base. Even the
	@# source lands mid-code there; no relocation rewrite can keep a row that
	@# two bases read (the known limit of open-domain tables).

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

pie-address-difference-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -fno-stack-protector -fPIE -static-pie \
		-Wl,--emit-relocs,--build-id=none \
		check/pie-address-difference.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

final-flags-after-value-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/final-flags-after-value.S \
		-o "$$temporary/input"; \
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
	$(CC) $(BARE_FIXTURE_FLAGS) \
		-Wl,--build-id=none check/noncontrol-rel32-fixture.S \
		-o "$$temporary/noncontrol-rel32"; \
	$(BUILD)/entry "$$temporary/noncontrol-rel32" \
		| grep -q '1 primary + 0 metadata entries; 0 observable addresses'; \
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
# A static link fills GOT slots itself and keeps no relocation for them; the
# slot of a code symbol must follow the code (found through the GOTPCREL row
# of the call). Without that the output calls the old layout and still says
# green, so only running it shows the difference.
.PHONY: lane-dec-branch-check
check: lane-dec-branch-check
lane-dec-branch-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/lane-dec-branch.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output" >/dev/null; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	echo "lane DEC branch: green"

.PHONY: got-slot-check
check: got-slot-check
got-slot-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O2 -mno-red-zone -Wa,-mrelax-relocations=no -static -no-pie \
		-nostdlib -fno-stack-protector -Wl,--emit-relocs,--build-id=none \
		check/got-slot-fixture.c -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output" >/dev/null; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	echo "GOT slot rebinding: green"

call-cut-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O2 -fPIE -pie -nostdlib -fno-stack-protector \
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

.PHONY: table-call-alias-check
table-call-alias-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/table-call-alias.S -o "$$temporary/input"; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		> "$$temporary/tables"; cat "$$temporary/tables"; \
	grep -Eq '^tables=2 targets=7$$' "$$temporary/tables"; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify "$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/input"; source_status=$$?; \
	"$$temporary/output"; output_status=$$?; set -e; \
	printf 'table-call-alias: source=%s output=%s\n' "$$source_status" "$$output_status"; \
	test $$source_status -eq 42; test $$output_status -eq 42; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none -DCLOBBER_ALIAS \
		check/table-call-alias.S -o "$$temporary/broken"; \
	$(BUILD)/native-closure "$$temporary/broken" --list-tables \
		> "$$temporary/broken-tables"; cat "$$temporary/broken-tables"; \
	grep -Eq '^tables=1 targets=2$$' "$$temporary/broken-tables"; \
	$(call same_as_source,"$$temporary/broken"); \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none -DESCAPED_SPILL \
		check/table-call-alias.S -o "$$temporary/escaped"; \
	$(BUILD)/native-closure "$$temporary/escaped" --list-tables \
		> "$$temporary/escaped-tables"; cat "$$temporary/escaped-tables"; \
	grep -Eq '^tables=1 targets=2$$' "$$temporary/escaped-tables"; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none -DMID_INSTRUCTION_CLOBBER \
		check/table-call-alias.S -o "$$temporary/interior"; \
	$(BUILD)/native-closure "$$temporary/interior" --list-tables \
		> "$$temporary/interior-tables"; cat "$$temporary/interior-tables"; \
	grep -Eq '^tables=1 targets=2$$' "$$temporary/interior-tables"; \
	$(call same_as_source,"$$temporary/interior")

check: table-call-alias-check

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

call-register-lifetime-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/call-register-lifetime.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'call-return register lifetime: green\n'

check: call-register-lifetime-check

shift-count-alias-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/shift-count-alias.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'entry CL shift alias: green\n'

check: shift-count-alias-check

.PHONY: shift-count-publication-check
shift-count-publication-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/shift-count-publication.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'shift count publication: green\n'

check: shift-count-publication-check

.PHONY: shift-count-generation-check
shift-count-generation-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/shift-count-generation.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'shift count generation: green\n'

check: shift-count-generation-check

.PHONY: post-call-zero-generation-check
post-call-zero-generation-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/post-call-zero-generation.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'post-call zero generation: green\n'

check: post-call-zero-generation-check

.PHONY: setcc-upper-bits-check
setcc-upper-bits-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/setcc-upper-bits.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'SETcc full-width publication: green\n'

check: setcc-upper-bits-check

wide-indexed-address-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/wide-indexed-address.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'wide indexed pointer: green\n'

check: wide-indexed-address-check

bitmap-complement-mask-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/bitmap-complement-mask.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'bitmap complement mask: green\n'

check: bitmap-complement-mask-check

affine-generation-order-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/affine-generation-order.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	"$$temporary/linked" a b c; \
	address=$$(nm "$$temporary/linked" | awk '$$3 == "affine_start" { print "0x" $$1 }'); \
	test -n "$$address"; \
	$(BUILD)/native-closure "$$temporary/linked" --dump-source "$$address" \
		> "$$temporary/candidates"; \
	! grep -q 'code=4c8d6df8' "$$temporary/candidates"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	"$$temporary/optimized" a b c; \
	printf 'affine generation order: green\n'

check: affine-generation-order-check

bitmask-pointer-lifetime-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/bitmask-pointer-lifetime.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	address=$$(nm "$$temporary/linked" | awk '$$3 == "mask_pointer_start" { print "0x" $$1 }'); \
	test -n "$$address"; \
	$(BUILD)/native-closure "$$temporary/linked" --dump-projected \
		"$$address" > "$$temporary/candidates"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'bitmask pointer lifetime: green\n'

check: bitmask-pointer-lifetime-check

.PHONY: scaled-address-generation-check
scaled-address-generation-check: $(PROGRAM) $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/scaled-address-generation.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	address=$$(nm "$$temporary/linked" | awk '$$3 == "scaled_address_start" { print "0x" $$1 }'); \
	test -n "$$address"; \
	$(BUILD)/native-closure "$$temporary/linked" --dump-projected \
		"$$address" > "$$temporary/candidates"; \
	if grep -q 'code=48c1e2024c89e64c8d0497' "$$temporary/candidates"; then \
		printf 'scaled address reused an already published shift\n' >&2; \
		exit 1; \
	fi; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'scaled address generation: green\n'

check: scaled-address-generation-check

.PHONY: published-entry-generation-check
published-entry-generation-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/published-entry-generation.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'published entry generation: green\n'

check: published-entry-generation-check

.PHONY: conditional-entry-alias-check
conditional-entry-alias-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -nostdlib -no-pie -Wl,--emit-relocs \
		check/conditional-entry-alias.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'conditional entry alias: green\n'

check: conditional-entry-alias-check

.PHONY: lane32-publication-check
lane32-publication-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) \
		check/lane32-publication.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf '32-bit publication after 64-bit shift: green\n'

check: lane32-publication-check

.PHONY: register-update-check
check: register-update-check
register-update-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) check/register-update.S -o "$$temporary/linked"; \
	"$$temporary/linked"; \
	$(PROGRAM) "$$temporary/linked" -o "$$temporary/optimized"; \
	"$$temporary/optimized"; \
	printf 'register update native ELF: green (conditional upper halves and AL/AH aliases)\n'

$(BUILD)/select-x86: check/select-x86.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/select-x86.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

select-x86-check: $(BUILD)/select-x86
	$(BUILD)/select-x86

$(BUILD)/selector-reentrancy: check/selector-reentrancy.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -pthread $< $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

.PHONY: selector-reentrancy-check sanitizer-check thread-sanitizer-check
selector-reentrancy-check: $(BUILD)/selector-reentrancy
	$(BUILD)/selector-reentrancy

sanitizer-check:
	bash check/sanitizers.sh address,undefined

thread-sanitizer-check:
	bash check/sanitizers.sh thread

check: selector-reentrancy-check

$(BUILD)/selection-policy: check/selection-policy.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

.PHONY: selection-policy-check
selection-policy-check: $(BUILD)/selection-policy
	$(BUILD)/selection-policy

check: selection-policy-check

$(BUILD)/compiler-boundaries: check/compiler-boundaries.c $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

.PHONY: compiler-boundaries-check
compiler-boundaries-check: $(BUILD)/compiler-boundaries
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/relocation-free-fixture.S -o "$$temporary/input"; \
	$(BUILD)/compiler-boundaries "$$temporary/input"

check: compiler-boundaries-check

.PHONY: source-layout-check
source-layout-check: $(LIBRARY)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	printf '%s\n' $(SOURCES) | LC_ALL=C sort >"$$temporary/declared"; \
	find src -type f -name '*.c' | LC_ALL=C sort >"$$temporary/actual"; \
	diff -u "$$temporary/declared" "$$temporary/actual"; \
	$(AR) t $(LIBRARY) | LC_ALL=C sort | uniq -d >"$$temporary/duplicates"; \
	test ! -s "$$temporary/duplicates" || \
		{ cat "$$temporary/duplicates" >&2; exit 1; }

check: source-layout-check

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

.PHONY: compare-cut-check
$(BUILD)/compare-cut: check/compare-cut.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/compare-cut.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

compare-cut-check: $(BUILD)/compare-cut
	$(BUILD)/compare-cut

check: compare-cut-check

.PHONY: carry-cut-check
$(BUILD)/carry-cut: check/carry-cut.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/carry-cut.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

carry-cut-check: $(BUILD)/carry-cut
	$(BUILD)/carry-cut

check: carry-cut-check

.PHONY: shared-expression-check
$(BUILD)/shared-expression: check/shared-expression.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/shared-expression.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

shared-expression-check: $(BUILD)/shared-expression
	$(BUILD)/shared-expression

check: shared-expression-check

.PHONY: extension-cut-check
$(BUILD)/extension-cut: check/extension-cut.c check/execute.h $(LIBRARY) dependencies
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/extension-cut.c $(LIBRARY) \
		../x86/build/libx86.a ../optimized-x86/build/liboptimized-x86.a \
		../support/build/libsupport.a -o $@

extension-cut-check: $(BUILD)/extension-cut
	$(BUILD)/extension-cut

check: extension-cut-check

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

.PHONY: stack-code-continuation-check
stack-code-continuation-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for variant in near far copy; do \
		flags=; \
		case $$variant in far) flags=-DFAR_RETURN;; copy) flags=-DCOPY_ADDRESS;; esac; \
		$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none $$flags \
			check/stack-code-continuation.S -o "$$temporary/$$variant.input"; \
		set +e; "$$temporary/$$variant.input"; source_status=$$?; set -e; \
		test $$source_status -eq 42; \
		$(PROGRAM) "$$temporary/$$variant.input" -o "$$temporary/$$variant.output"; \
		../optimized-x86/build/postlink-verify \
			"$$temporary/$$variant.input" "$$temporary/$$variant.output"; \
		set +e; "$$temporary/$$variant.output"; output_status=$$?; set -e; \
		test $$output_status -eq 42; \
	done

.PHONY: observed-call-site-check
observed-call-site-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/observed-call-site.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

.PHONY: partial-pointer-clear-check
partial-pointer-clear-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for flags in '' '-DCLEAR_WORD' '-DCLEAR_AND' '-DCLEAR_EXTENDED' \
		'-DCLEAR_WORD -DCLEAR_EXTENDED'; do \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		$$flags check/partial-pointer-clear.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	done

.PHONY: relative-function-table-check
relative-function-table-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/relative-function-table.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42

.PHONY: bit-scan-passthrough-check
bit-scan-passthrough-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for flags in '' '-DSCAN_WORD' '-DSCAN_QUAD' '-DSCAN_REVERSE' \
		'-DSCAN_WORD -DSCAN_REVERSE' '-DSCAN_QUAD -DSCAN_REVERSE'; do \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		$$flags check/bit-scan-passthrough.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	test $$output_status -eq 42; \
	done

.PHONY: cpuid-inputs-check partial-clear-after-flags-check atomic-inputs-check mutable-immediate-field-check unowned-relative-field-check mixed-relative-field-check prefixed-rel32-site-check exception-table-root-check bug-table-root-check tail-call-table-check tail-call-table-rejection-check indirect-flags-frontier-check entry-flags-preload-check
entry-alu-capture-check boolean-entry-capture-check cpuid-inputs-check partial-clear-after-flags-check atomic-inputs-check mutable-immediate-field-check unowned-relative-field-check mixed-relative-field-check prefixed-rel32-site-check exception-table-root-check bug-table-root-check tail-call-table-check indirect-flags-frontier-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) $(BARE_FIXTURE_FLAGS) -Wl,--build-id=none \
		check/$(@:-check=).S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	if test $$output_status -ne 42; then \
	printf '%s: optimized exit %s, expected source exit 42\n' \
		'$@' "$$output_status" >&2; exit 1; fi

entry-flags-preload-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for variant in 0 1 2 3; do \
	$(CC) $(BARE_FIXTURE_FLAGS) -DENTRY_FLAGS_CASE=$$variant \
		-Wl,--build-id=none check/entry-flags-preload.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	if test $$output_status -ne 42; then \
	printf 'entry-flags-preload variant %s: optimized exit %s, expected 42\n' \
		"$$variant" "$$output_status" >&2; exit 1; fi; \
	done

.PHONY: compare-address-flags-check
compare-address-flags-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for variant in 0 1 2 3; do \
	$(CC) $(BARE_FIXTURE_FLAGS) -DCOMPARE_ADDRESS_CASE=$$variant \
		-Wl,--build-id=none check/compare-address-flags.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	if test $$output_status -ne 42; then \
	printf 'compare-address-flags variant %s: optimized exit %s, expected 42\n' \
		"$$variant" "$$output_status" >&2; exit 1; fi; \
	done

check: compare-address-flags-check

.PHONY: transient-entry-generation-check
transient-entry-generation-check: $(PROGRAM)
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for variant in 0 1 2; do \
	$(CC) $(BARE_FIXTURE_FLAGS) -DTRANSIENT_ENTRY_CASE=$$variant \
		-Wl,--build-id=none check/transient-entry-generation.S -o "$$temporary/input"; \
	set +e; "$$temporary/input"; source_status=$$?; set -e; \
	test $$source_status -eq 42; \
	$(PROGRAM) "$$temporary/input" -o "$$temporary/output"; \
	../optimized-x86/build/postlink-verify \
		"$$temporary/input" "$$temporary/output"; \
	set +e; "$$temporary/output"; output_status=$$?; set -e; \
	if test $$output_status -ne 42; then \
	printf 'transient-entry-generation variant %s: optimized exit %s, expected 42\n' \
		"$$variant" "$$output_status" >&2; exit 1; fi; \
	done

check: transient-entry-generation-check

tail-call-table-rejection-check: $(PROGRAM) $(BUILD)/entry $(BUILD)/native-closure
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	for bypass in 1 2; do \
	$(CC) $(BARE_FIXTURE_FLAGS) -DBYPASS_GUARD=$$bypass \
		-Wl,--build-id=none check/tail-call-table.S -o "$$temporary/input"; \
	$(BUILD)/entry "$$temporary/input" >"$$temporary/entries"; \
	grep -xF 'recognized table projection: 1 bases, 2 rows' \
		"$$temporary/entries" >/dev/null; \
	$(BUILD)/native-closure "$$temporary/input" --list-tables \
		| grep -Eq '^tables=0 targets=0$$'; \
	$(call same_as_source,"$$temporary/input"); \
	done

check: closed-table-set-check interior-trampoline-check stack-code-continuation-check observed-call-site-check partial-pointer-clear-check relative-function-table-check bit-scan-passthrough-check cpuid-inputs-check partial-clear-after-flags-check atomic-inputs-check mutable-immediate-field-check unowned-relative-field-check mixed-relative-field-check prefixed-rel32-site-check exception-table-root-check bug-table-root-check tail-call-table-check tail-call-table-rejection-check indirect-flags-frontier-check entry-flags-preload-check table-base-reuse-after-target-check

check: $(PROGRAM) $(BUILD)/completeness elf-proof-check observed-compile-check relocation-free-product-check product-gate-check shared-product-gate-check runtime-elf-check modular-address-check physical-entry-check code-grid-check relative-code-pointer-check table-alternative-bound-check stack-slot-table-check copied-memory-table-check backward-exit-table-check backward-loop-table-check chained-table-cut-check nested-table-guards-check local-code-address-check pie-address-difference-check final-flags-after-value-check observed-code-span-check mutable-code-site-check trap-continuation-check alternative-record-check linked-field-authority-check table-side-exit-check call-cut-check dispatch-alias-check profile-extension-check overlapping-control-check patch-trampoline-check mixed-load-check nonimage-control-check dynamic-runtime-check metadata-closure-check entry-check native-closure-check select-x86-check native-layout-check population-check direct-control-check scalar-check physical-check quotient-check normal-form-check global-minimum-check block-observation-check slice-observation-check instruction-law-check distribution-population-check production-benchmark-fixture-check
	@! grep -REn 'PL_VM_|pl_vm_|wasm-compiler|machine-artifact|delivery|worker' \
		include src cli
	$(BUILD)/completeness

clean:
	rm -rf $(BUILD)

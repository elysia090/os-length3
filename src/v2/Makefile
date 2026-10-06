PRODUCTS = support x86 optimized-x86 machine-abi artifact storage \
	postlink-compiler wasm-compiler vm
BUILD ?= build
SITE ?= ../../dist
ARTIFACT ?= ../../artifact
CC ?= cc
CFLAGS ?= -O2
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
INCLUDES = -Iartifact/include -Ipostlink-compiler/include \
	-Ioptimized-x86/include -Ix86/include -Isupport/include

.PHONY: all check site release-sharing-check artifact-executable-stage-check native-bundle-check postlinked-kernel-package-check service-source-check package-payload-check \
	clean $(PRODUCTS)
all: $(PRODUCTS) $(BUILD)/artifact-executable-stage

# Assemble the static browser shell and its sibling artifact root. The page is
# plain files under web/; there is no JavaScript build step. The browser opens
# objects from a sibling artifact/ directory, which is the generated tree at
# the repository root and is copied only when it exists.
site:
	rm -rf "$(SITE)"
	mkdir -p "$(SITE)"
	cp -R web/. "$(SITE)"/
	@if [ -d "$(ARTIFACT)" ]; then cp -R "$(ARTIFACT)" "$(SITE)"/artifact; fi

# Recursive makes do not share a dependency graph. Finish each provider before
# starting its consumers, including on an empty tree under `make -j`.
x86 optimized-x86 machine-abi artifact storage: support
postlink-compiler: x86 optimized-x86
wasm-compiler: x86 optimized-x86 machine-abi
vm: machine-abi artifact storage

$(PRODUCTS):
	$(MAKE) -C $@ all

$(BUILD):
	mkdir -p $@

$(BUILD)/complete-release: check/complete-release.c artifact/cli/measure-namespace.c $(PRODUCTS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -DARTIFACT_NAMESPACE_LIBRARY \
		check/complete-release.c artifact/cli/measure-namespace.c \
		postlink-compiler/build/libpostlink.a \
		artifact/build/libartifact.a x86/build/libx86.a \
		optimized-x86/build/liboptimized-x86.a \
		support/build/libsupport.a -o $@

$(BUILD)/artifact-executable-stage: check/complete-release.c artifact/cli/measure-namespace.c $(PRODUCTS) | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) -DARTIFACT_NAMESPACE_LIBRARY \
		check/complete-release.c artifact/cli/measure-namespace.c \
		postlink-compiler/build/libpostlink.a \
		artifact/build/libartifact.a x86/build/libx86.a \
		optimized-x86/build/liboptimized-x86.a \
		support/build/libsupport.a -o $@

release-sharing-check: $(BUILD)/complete-release
	@set -eu; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(CC) -O0 -g -Wl,--emit-relocs \
		postlink-compiler/check/elf-proof-fixture.c \
		-o "$$temporary/input-a"; \
	$(CC) -O0 -g -DRELEASE_SHARING_VARIANT -Wl,--emit-relocs \
		postlink-compiler/check/elf-proof-fixture.c \
		-o "$$temporary/input-b"; \
	! cmp -s "$$temporary/input-a" "$$temporary/input-b"; \
	$(BUILD)/complete-release "$$temporary/input-a" "$$temporary/input-b"

artifact-executable-stage-check: $(BUILD)/artifact-executable-stage
	@set -eu; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	mkdir -p "$$temporary/root" "$$temporary/output"; \
	$(CC) -nostdlib -no-pie -Wl,--build-id=none,--emit-relocs \
		check/artifact-stage-fixture.S check/artifact-stage-body.S \
		-o "$$temporary/root/input-a"; \
	$(CC) -nostdlib -no-pie -DRELEASE_SHARING_VARIANT \
		-Wl,--build-id=none,--emit-relocs \
		check/artifact-stage-fixture.S check/artifact-stage-body.S \
		-o "$$temporary/root/input-b"; \
	$(BUILD)/artifact-executable-stage --stage "$$temporary/report" \
		--namespace-root "$$temporary/root" \
		--payload-root "$$temporary/root" \
		--archives 0 --payloads 0 --elfs \
		"$$temporary/root/input-b" "$$temporary/output/output-b" \
		"$$temporary/root/input-a" "$$temporary/output/output-a"; \
	optimized-x86/build/postlink-verify \
		"$$temporary/root/input-a" "$$temporary/output/output-a" >/dev/null; \
	optimized-x86/build/postlink-verify \
		"$$temporary/root/input-b" "$$temporary/output/output-b" >/dev/null; \
	grep -qxF 'format=artifact-executable-stage-v13' "$$temporary/report"; \
	grep -qxF 'complete_gate=1' "$$temporary/report"; \
	grep -qxF 'semantic_family_mask=63' "$$temporary/report"; \
	grep -qxF 'namespace_paths=3' "$$temporary/report"; \
	grep -qxF 'namespace_inodes=3' "$$temporary/report"; \
	grep -Eq '^normal_instruction_occurrences=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_classes=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_shared_occurrences=[0-9]+$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_opened_bytes=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_class_bytes=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -qxF 'stored_normal_instruction_bytes=0' "$$temporary/report"; \
	grep -Eq '^normal_instruction_minimum_proofs=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_joint_witnesses=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_work_lower_bound_sum=[0-9]+$$' "$$temporary/report"; \
	grep -Eq '^normal_instruction_span_lower_bound_sum=[0-9]+$$' "$$temporary/report"; \
	grep -Eq '^checked_successor_coordinates=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -qxF 'stored_residual_state_rows=0' "$$temporary/report"; \
	grep -qxF 'stored_residual_edge_rows=0' "$$temporary/report"; \
	grep -Eq '^future_classes=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^canonical_byte_extent=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -qxF 'optimized_elfs=2' "$$temporary/report"; \
	grep -qxF 'postlink_normalized_emission_complete=1' "$$temporary/report"; \
	grep -qxF 'postlink_normalization_escape_blocks=0' "$$temporary/report"; \
	grep -Eq '^postlink_normalization_escape_blocks=[0-9]+$$' "$$temporary/report"; \
	grep -Eq '^postlink_normalization_escape_source_bytes=[0-9]+$$' "$$temporary/report"; \
	grep -Eq '^postlink_normalization_escape_output_bytes=[0-9]+$$' "$$temporary/report"; \
	grep -Eq '^postlink_normalization_escape_work=[0-9]+$$' "$$temporary/report"; \
	grep -qxF 'postlink_pareto_unresolved_blocks=0' "$$temporary/report"; \
	grep -Eq '^state_capacity_growths=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^elf_capacity_growths=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -Eq '^factor_bytes=[1-9][0-9]*$$' "$$temporary/report"; \
	grep -qxF 'factor_gap_bits=0' "$$temporary/report"; \
	mkdir -p "$$temporary/escape-root" "$$temporary/escape-output"; \
	$(CC) -O0 -g -Wl,--emit-relocs \
		postlink-compiler/check/elf-proof-fixture.c \
		-o "$$temporary/escape-root/input"; \
	$(BUILD)/artifact-executable-stage \
		--stage "$$temporary/escape-report" \
		--namespace-root "$$temporary/escape-root" \
		--payload-root "$$temporary/escape-root" \
		--archives 0 --payloads 0 --elfs \
		"$$temporary/escape-root/input" \
		"$$temporary/escape-output/output"; \
	grep -qxF 'complete_gate=1' "$$temporary/escape-report"; \
	optimized-x86/build/postlink-verify "$$temporary/escape-root/input" \
		"$$temporary/escape-output/output"; \
	printf orphan >"$$temporary/root/orphan"; \
	! $(BUILD)/artifact-executable-stage --stage "$$temporary/red-report" \
		--namespace-root "$$temporary/root" \
		--payload-root "$$temporary/root" \
		--archives 0 --payloads 0 --elfs \
		"$$temporary/root/input-a" "$$temporary/output/red-a" \
		"$$temporary/root/input-b" "$$temporary/output/red-b" \
		2>/dev/null

native-bundle-check:
	bash ../../data/distribution/check-native-bundle.sh

postlinked-kernel-package-check:
	bash ../../data/oracle/check-package-postlinked-kernel.sh

service-source-check:
	bash ../../data/distribution/check-service-sources-fixture.sh

package-payload-check:
	bash ../../data/distribution/check-package-payload.sh

check: release-sharing-check artifact-executable-stage-check native-bundle-check postlinked-kernel-package-check service-source-check package-payload-check
	@for product in $(PRODUCTS); do $(MAKE) -C $$product check || exit; done
	@! test -e qm
	@! test -e kernel
	@! test -e tests
	@! test -e tools
	@! test -e machine-artifact
	@! test -e vm/wasm/vm.c
	@! test -e wasm-compiler/src/lower-vector-permutation.c
	@! test -e wasm-compiler/src/lower-vector-arithmetic.c
	@! test -e postlink-compiler/src/instruction-semantics.c
	@! test -e postlink-compiler/src/normalize-ssa.c
	@test -d web
	@! grep -REn 'Pyodide|pyodide|from qm|import qm|from kernel|import kernel|machine-artifact/' \
		--exclude=Makefile --exclude='*.md' --exclude-dir=build \
		--exclude-dir=third_party web vm postlink-compiler wasm-compiler

clean:
	@for product in $(PRODUCTS); do $(MAKE) -C $$product clean || exit; done
	rm -rf $(BUILD)

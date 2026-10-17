CC ?= cc
AR ?= ar
CFLAGS ?= -O2
DEPFLAGS = -MMD -MP
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion
BUILD ?= build
INCLUDES = -Iinclude -I../support/include
include sources.mk
SOURCES = $(ARTIFACT_SOURCES)
OBJECTS = $(patsubst src/%.c,$(BUILD)/%.o,$(SOURCES))
DEPS = $(OBJECTS:.o=.d)

.PHONY: all check index-check immutable-check share-check layout-check factor-check \
	factor-index-check payload-check derive-check archive-check \
	factor-codec-check rank-map-check future-check complete-check \
	namespace-check namespace-measure-check namespace-xattrs-check clean

.PHONY: program-check executable-check factor-benchmark
all: $(BUILD)/libartifact.a $(BUILD)/artifact-measure-root \
	$(BUILD)/artifact-measure-namespace $(BUILD)/artifact-normalize-archive

$(BUILD):
	mkdir -p $@

.PHONY: support-dependency
support-dependency:
	$(MAKE) -C ../support all

../support/build/libsupport.a: | support-dependency

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(DEPFLAGS) $(INCLUDES) \
		-ffreestanding -c $< -o $@

$(BUILD)/libartifact.a: $(OBJECTS) Makefile sources.mk | ../support/build/libsupport.a
	$(RM) $@.tmp
	$(AR) rcs $@.tmp $(OBJECTS)
	mv $@.tmp $@

$(BUILD)/artifact-measure-root: cli/measure-root.c $(BUILD)/libartifact.a ../support/build/libsupport.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/measure-root.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

$(BUILD)/artifact-measure-namespace: cli/measure-namespace.c $(BUILD)/libartifact.a ../support/build/libsupport.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/measure-namespace.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

$(BUILD)/artifact-normalize-archive: cli/normalize-archive.c $(BUILD)/libartifact.a ../support/build/libsupport.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/normalize-archive.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

$(BUILD)/immutable-check: check/immutable.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/immutable.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

immutable-check: $(BUILD)/immutable-check
	$(BUILD)/immutable-check

$(BUILD)/index-check: check/index.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/index.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

index-check: $(BUILD)/index-check
	$(BUILD)/index-check

.PHONY: index-stream-check
check: index-stream-check
$(BUILD)/index-stream-check: check/index-stream.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) $< $(BUILD)/libartifact.a ../support/build/libsupport.a -o $@
index-stream-check: $(BUILD)/index-stream-check
	$(BUILD)/index-stream-check

$(BUILD)/share-check: check/share.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/share.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

share-check: $(BUILD)/share-check
	$(BUILD)/share-check

$(BUILD)/payload-check: check/payload.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/payload.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

payload-check: $(BUILD)/payload-check
	$(BUILD)/payload-check

$(BUILD)/derive-check: check/derive.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/derive.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

derive-check: $(BUILD)/derive-check
	$(BUILD)/derive-check

$(BUILD)/layout-check: check/layout.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/layout.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

layout-check: $(BUILD)/layout-check
	$(BUILD)/layout-check

$(BUILD)/factor-check: check/factor.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/factor.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

factor-check: $(BUILD)/factor-check
	$(BUILD)/factor-check

$(BUILD)/factor-index-check: check/factor-index.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/factor-index.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

factor-index-check: $(BUILD)/factor-index-check
	$(BUILD)/factor-index-check

$(BUILD)/factor-benchmark: check/factor-benchmark.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/factor-benchmark.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

factor-benchmark: $(BUILD)/factor-benchmark

$(BUILD)/factor-codec-check: check/factor-codec.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/factor-codec.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

factor-codec-check: $(BUILD)/factor-codec-check
	$(BUILD)/factor-codec-check

$(BUILD)/rank-map-check: check/rank-map.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/rank-map.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

rank-map-check: $(BUILD)/rank-map-check
	$(BUILD)/rank-map-check

$(BUILD)/future-check: check/future.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/future.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

future-check: $(BUILD)/future-check
	$(BUILD)/future-check

$(BUILD)/complete-check: check/complete.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/complete.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

complete-check: $(BUILD)/complete-check
	$(BUILD)/complete-check

$(BUILD)/namespace-check: check/namespace.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/namespace.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

namespace-check: $(BUILD)/namespace-check
	$(BUILD)/namespace-check

$(BUILD)/namespace-xattrs-check: cli/measure-namespace.c check/namespace-xattrs.c $(BUILD)/libartifact.a ../support/build/libsupport.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) cli/measure-namespace.c \
		check/namespace-xattrs.c $(BUILD)/libartifact.a \
		../support/build/libsupport.a -Wl,--wrap=llistxattr -o $@

namespace-xattrs-check: $(BUILD)/artifact-measure-namespace $(BUILD)/namespace-xattrs-check
	@set -e; temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	mkdir "$$temporary/root"; printf x >"$$temporary/root/tool"; \
	ln -s tool "$$temporary/root/link"; \
	expected=$$($(BUILD)/artifact-measure-namespace --identity "$$temporary/root"); \
	test "$$($(BUILD)/namespace-xattrs-check --identity "$$temporary/root")" = "$$expected"; \
	if ARTIFACT_TEST_LINK_XATTR_ERROR=io $(BUILD)/namespace-xattrs-check --identity "$$temporary/root" >/dev/null 2>&1; then \
		echo 'namespace identity accepted an xattr I/O error' >&2; exit 1; \
	fi; \
	echo 'namespace xattrs: unsupported links agree; I/O errors rejected'

namespace-measure-check: $(BUILD)/artifact-measure-namespace
	@temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	mkdir -p "$$temporary/root/bin" "$$temporary/root/lib"; \
	printf x >"$$temporary/root/bin/tool"; \
	ln "$$temporary/root/bin/tool" "$$temporary/root/lib/tool"; \
	ln -s bin/tool "$$temporary/root/link"; \
	$(BUILD)/artifact-measure-namespace \
		"$$temporary/root" "$$temporary/report"; \
	grep -qxF 'format=artifact-namespace-population-v1' \
		"$$temporary/report"; \
	grep -qxF 'paths=6' "$$temporary/report"; \
	grep -qxF 'inodes=5' "$$temporary/report"; \
	grep -qxF 'hardlink_aliases=1' "$$temporary/report"; \
	grep -qxF 'factor_gap_bits=0' "$$temporary/report"

$(BUILD)/program-check: check/program.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/program.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

program-check: $(BUILD)/program-check
	$(BUILD)/program-check

$(BUILD)/executable-check: check/executable.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/executable.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

executable-check: $(BUILD)/executable-check
	$(BUILD)/executable-check

$(BUILD)/archive-check: check/archive.c $(BUILD)/libartifact.a | $(BUILD)
	$(CC) $(CFLAGS) $(WARN) $(INCLUDES) check/archive.c \
		$(BUILD)/libartifact.a ../support/build/libsupport.a -o $@

archive-check: $(BUILD)/archive-check
	@temporary=$$(mktemp -d); \
	trap 'rm -rf "$$temporary"' EXIT; \
	$(BUILD)/archive-check "$$temporary/generated.a"; \
	test "$$($(AR) t "$$temporary/generated.a")" = \
		"$$(printf 'a.o\nsame-meaning-at-another-name.o')"

check: all index-check immutable-check share-check payload-check derive-check layout-check factor-check factor-index-check factor-codec-check archive-check rank-map-check future-check program-check executable-check complete-check namespace-check namespace-measure-check namespace-xattrs-check
	@! grep -REn '#include <(x86|optimized-x86|postlink|machine|wasm-compiler|storage|vm)/' include src
	bash check/measure-root.sh $(BUILD)/artifact-measure-root

clean:
	rm -rf $(BUILD)

-include $(DEPS)

# The same freestanding identity/index reader serves native and Wasm owners.
ARTIFACT_INDEX_SOURCES = src/index.c src/object.c src/resource.c
ARTIFACT_SOURCES = $(ARTIFACT_INDEX_SOURCES) src/index-stream.c src/root.c src/immutable.c \
	src/share.c src/payload.c src/derive.c src/layout.c src/factor.c \
	src/factor-index.c src/factor-codec.c src/archive.c src/rank-map.c \
	src/future.c src/complete.c src/namespace.c src/program.c src/executable.c

#ifndef WASM_IMAGE_INTERNAL_H
#define WASM_IMAGE_INTERNAL_H
#include "internal.h"
typedef struct {
    pl_x86_map maps[64];
    pl_x86_image image;
    pl_u64 coordinates;
} wasm_image_view;
int wasm_image_open(const wasm_compiler *compiler,wasm_image_view *view);
#endif

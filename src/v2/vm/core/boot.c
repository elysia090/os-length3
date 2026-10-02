#include <vm/boot.h>
#include "memory-internal.h"
#include <stddef.h>

enum { PARAMS = 0x1000, COMMAND = 0x2000, GDT = 0x3000,
       PML4 = 0x4000, PDPT = 0x5000, PD = 0x6000 };

int vm_boot_open(vm_boot *boot, const pl_u8 *header, pl_u32 header_bytes,
                  pl_u64 image_bytes, pl_u64 initramfs_bytes, pl_u64 ram_bytes,
                  const pl_u8 *command, pl_u32 command_bytes)
{
    if (!boot) return -1;
    *boot = (vm_boot){ 0 };
    if (!header || header_bytes < 0x270u || !command || command_bytes > 4095u
            || ram_bytes < 0x4000000u || ram_bytes > 0x40000000u
            || (ram_bytes & 4095u) || !initramfs_bytes || initramfs_bytes > ram_bytes
            || vm_memory_load(header + 0x1feu, 2u) != 0xaa55u
            || vm_memory_load(header + 0x202u, 4u) != 0x53726448u
            || vm_memory_load(header + 0x206u, 2u) < 0x20cu
            || !(header[0x211u] & 1u) || !(header[0x236u] & 1u)
            || header[0x200u] != 0xebu) return -1;
    pl_u32 end = 0x202u + header[0x201u];
    if (end < 0x264u || end > 0x290u || end > header_bytes
            || command_bytes > vm_memory_load(header + 0x238u, 4u)) return -1;
    for (pl_u32 i = 0u; i < command_bytes; ++i) if (!command[i]) return -1;
    pl_u64 offset = ((pl_u64)(header[0x1f1u] ? header[0x1f1u] : 4u) + 1u) * 512u;
    pl_u64 bytes = vm_memory_load(header + 0x1f4u, 4u) * 16u;
    pl_u64 address = vm_memory_load(header + 0x258u, 8u);
    pl_u64 reservation = vm_memory_load(header + 0x260u, 4u);
    pl_u64 alignment = vm_memory_load(header + 0x230u, 4u);
    if (offset >= image_bytes || bytes < 0x201u || bytes > image_bytes - offset
            || !alignment || (alignment & (alignment - 1u)) || alignment < 4096u
            || address < 0x100000u || (address & (alignment - 1u))
            || address > ram_bytes || reservation < bytes
            || reservation > ram_bytes - address) return -1;
    pl_u64 initramfs = (address + reservation + 4095u) & ~4095ull;
    if (initramfs > ram_bytes || initramfs_bytes > ram_bytes - initramfs
            || initramfs + initramfs_bytes - 1u > vm_memory_load(header + 0x22cu, 4u))
        return -1;
    *boot = (vm_boot){ header, command, end, command_bytes, ram_bytes,
                      offset, bytes, address, reservation, initramfs_bytes, initramfs };
    return 0;
}

static void e820(pl_u8 *page, pl_u32 row, pl_u64 address, pl_u64 bytes, pl_u32 type)
{
    pl_u8 *at = page + 0x2d0u + row * 20u;
    vm_memory_store(at, address, 8u); vm_memory_store(at + 8u, bytes, 8u);
    vm_memory_store(at + 16u, type, 4u);
}

int vm_boot_page(const vm_boot *boot, pl_u64 address, pl_u8 *target,
                  vm_boot_source *source)
{
    if (!boot || !boot->header || !target || !source || (address & 4095u)
            || address >= boot->ram_bytes || (address >= 0xa0000u && address < 0x100000u))
        return -1;
    pl_u64 offset = 0u, bytes = 0u;
    pl_u32 kind = VM_BOOT_ZERO;
    if (address >= boot->kernel_address && address - boot->kernel_address < boot->kernel_bytes) {
        offset = address - boot->kernel_address;
        bytes = boot->kernel_bytes - offset; kind = VM_BOOT_KERNEL;
        offset += boot->kernel_offset;
    } else if (address >= boot->initramfs_address && address - boot->initramfs_address < boot->initramfs_bytes) {
        offset = address - boot->initramfs_address;
        bytes = boot->initramfs_bytes - offset; kind = VM_BOOT_INITRAMFS;
    }
    if (bytes > 4096u) bytes = 4096u;
    *source = (vm_boot_source){ offset, (pl_u32)bytes, kind };
    if (kind != VM_BOOT_ZERO) return (int)kind;
    for (pl_u32 i = 0u; i < 4096u; ++i) target[i] = 0u;
    if (address == PARAMS) {
        for (pl_u32 i = 0x1f1u; i < boot->header_end; ++i) target[i] = boot->header[i];
        target[0x210u] = 0xffu; /* Unregistered loader; no real-mode setup. */
        target[0x1e8u] = 3u;
        vm_memory_store(target + 0x214u, boot->kernel_address, 4u);
        vm_memory_store(target + 0x218u, boot->initramfs_address, 4u);
        vm_memory_store(target + 0x21cu, boot->initramfs_bytes, 4u);
        vm_memory_store(target + 0x228u, COMMAND, 4u);
        /* These are loader-owned pointers, never bindings from file bytes. */
        vm_memory_store(target + 0x208u, 0u, 4u);
        vm_memory_store(target + 0x220u, 0u, 4u);
        vm_memory_store(target + 0x224u, 0u, 4u);
        vm_memory_store(target + 0x23cu, 0u, 4u);
        vm_memory_store(target + 0x240u, 0u, 8u);
        vm_memory_store(target + 0x250u, 0u, 8u);
        e820(target, 0u, 0u, 0xa0000u, 1u);
        e820(target, 1u, 0xa0000u, 0x60000u, 2u);
        e820(target, 2u, 0x100000u, boot->ram_bytes - 0x100000u, 1u);
    } else if (address == COMMAND) {
        for (pl_u32 i = 0u; i < boot->command_bytes; ++i) target[i] = boot->command[i];
    } else if (address == GDT) {
        vm_memory_store(target + 16u, 0x00af9b000000ffffull, 8u);
        vm_memory_store(target + 24u, 0x00cf93000000ffffull, 8u);
    } else if (address == PML4) vm_memory_store(target, PDPT | 3u, 8u);
    else if (address == PDPT) vm_memory_store(target, PD | 3u, 8u);
    else if (address == PD) for (pl_u32 i = 0u; i < 512u; ++i)
        vm_memory_store(target + i * 8u, (pl_u64)i * 0x200000u | 0x83u, 8u);
    else return VM_BOOT_ZERO;
    source->kind = VM_BOOT_METADATA;
    return VM_BOOT_METADATA;
}

int vm_boot_state(const vm_boot *boot, machine_state *state)
{
    if (!boot || !boot->header || !state) return -1;
    *state = (machine_state){ 0 };
    state->rip = boot->kernel_address + 0x200u;
    state->registers[4] = 0x10000u; state->registers[6] = PARAMS;
    state->rflags = 2u; state->cr0 = 0x80000011u;
    state->cr3 = PML4; state->cr4 = 32u; state->efer = 0x500u;
    state->system[MACHINE_SYSTEM_GDTR_BASE] = GDT;
    state->system[MACHINE_SYSTEM_GDTR_LIMIT] = 31u;
    state->system[MACHINE_SYSTEM_CS] = 16u;
    state->system[MACHINE_SYSTEM_DS] = state->system[MACHINE_SYSTEM_ES]
                                   = state->system[MACHINE_SYSTEM_SS] = 24u;
    state->mxcsr = 0x1f80u; state->x87_control = 0x37fu;
    state->x87_tag = 0xffffu;
    return 0;
}

int vm_boot_segments(const vm_boot *boot, machine_segments *segments)
{
    if (!boot || !boot->header || !segments) return -1;
    *segments = (machine_segments){0};
    segments->version = MACHINE_SEGMENTS_ABI_VERSION;
    for (pl_u32 i = 0u; i < MACHINE_SEGMENT_COUNT; ++i)
        segments->cache[i].attributes = MACHINE_SEGMENT_UNUSABLE;
    segments->cache[MACHINE_SEGMENT_CS] = (machine_segment_cache){0u,0xffffffffu,0xa09bu};
    segments->cache[MACHINE_SEGMENT_DS] = segments->cache[MACHINE_SEGMENT_ES]
        = segments->cache[MACHINE_SEGMENT_SS] = (machine_segment_cache){0u,0xffffffffu,0xc093u};
    return 0;
}

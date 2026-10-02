/* Host boot/memory admission. Generated cuts call access, not lifecycle APIs. */
#include <vm/mmu.h>
#include <vm/boot.h>
#include <machine/state.h>
#include "../core/memory-internal.h"
#include <stdint.h>

extern unsigned char __heap_base;
static vm_memory resident;
static pl_u32 arena_base;
static pl_u32 state_offset;
static vm_boot boot;
static pl_u32 boot_header, boot_header_bytes, boot_command;

pl_u32 vm_arena_min(void)
{
    return ((pl_u32)(uintptr_t)&__heap_base + 4095u) & ~4095u;
}

void vm_close(void)
{
    resident = (vm_memory){ 0 };
    arena_base = 0u;
    state_offset = 0u;
    boot = (vm_boot){ 0 };
    boot_header = boot_header_bytes = boot_command = 0u;
}

static int range(pl_u32 offset, pl_u32 bytes)
{
    return offset >= vm_arena_min()
        && (pl_u64)offset + bytes <= (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
}
static int separate(pl_u32 a, pl_u32 bytes, pl_u32 b, pl_u32 extent)
{ return (pl_u64)a + bytes <= b || (pl_u64)b + extent <= a; }
static int boot_output(pl_u32 offset, pl_u32 bytes)
{
    return boot.header && !resident.generation && range(offset, bytes)
        && separate(offset, bytes, boot_header, boot_header_bytes)
        && separate(offset, bytes, boot_command, boot.command_bytes);
}

/* Privileged cold loader exports, never imports granted to generated code.
 * Preparing a new boot revokes all previous memory/state/boot admission. */
int vm_boot_prepare(pl_u32 header, pl_u32 header_bytes, pl_u64 image_bytes,
                     pl_u64 initramfs_bytes, pl_u64 ram_bytes,
                     pl_u32 command, pl_u32 command_bytes)
{
    vm_close();
    if (!range(header, header_bytes) || !range(command, command_bytes)) return -1;
    if (vm_boot_open(&boot, (const pl_u8 *)(uintptr_t)header, header_bytes,
                     image_bytes, initramfs_bytes, ram_bytes,
                     (const pl_u8 *)(uintptr_t)command, command_bytes)) return -1;
    boot_header = header; boot_header_bytes = header_bytes; boot_command = command;
    return 0;
}

int vm_boot_project(pl_u64 address, pl_u32 target, pl_u32 source)
{
    if ((target & 4095u) || (source & 7u) || !boot_output(target, 4096u)
            || !boot_output(source, sizeof(vm_boot_source))
            || !separate(target, 4096u, source, sizeof(vm_boot_source))) return -1;
    return vm_boot_page(&boot, address, (pl_u8 *)(uintptr_t)target,
                         (vm_boot_source *)(uintptr_t)source);
}

int vm_boot_initial_state(pl_u32 state)
{
    if ((state & 7u) || !boot_output(state, sizeof(machine_state))) return -1;
    return vm_boot_state(&boot, (machine_state *)(uintptr_t)state);
}

/* A borrowed directory occupies supervisor memory below the guest arena.
 * No descriptor, RAM or CPU-state copy is made. The serialized owner pins
 * directory, translations and CPU context until every admitted cut returns.
 * Reopening after growth/reconfiguration revokes the previous admission first.
 * This entry point is not an import granted to translated guest programs. */
int vm_open(pl_u32 base, pl_u32 bytes, pl_u32 reserved,
            pl_u32 directory, pl_u32 count, pl_u64 generation)
{
    vm_close();
    pl_u64 extent = (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
    pl_u64 end = (pl_u64)base + bytes;
    pl_u64 directory_end = (pl_u64)directory + (pl_u64)count * sizeof(vm_memory_page);
    if ((base & 4095u) || base < vm_arena_min() || !bytes || end > extent
            || (directory & 7u) || directory < vm_arena_min()
            || directory_end > base) return -1;
    if (vm_memory_open(&resident, (pl_u8 *)(uintptr_t)base, bytes, reserved,
                       (const vm_memory_page *)(uintptr_t)directory,
                       count, generation)) return -1;
    arena_base = base;
    return 0;
}

int vm_bind_state(pl_u32 state)
{
    state_offset = 0u;
    if (!resident.generation || state < arena_base || (state & 7u)
            || (pl_u64)(state - arena_base) + sizeof(machine_state) > resident.reserved_bytes)
        return -1;
    state_offset = state;
    return 0;
}

machine_result vm_access(pl_u32 port, pl_u64 address, pl_u32 bytes,
                          pl_u32 access, pl_u64 value)
{
    if (!state_offset || port < arena_base
            || ((pl_u64)port < (pl_u64)state_offset + sizeof(machine_state)
                && (pl_u64)state_offset < (pl_u64)port + sizeof(machine_memory_port)))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    const pl_u8 *state = resident.bytes + state_offset - arena_base;
    vm_mmu_context context = {
        vm_memory_load(state + offsetof(machine_state, cr0), 8u),
        vm_memory_load(state + offsetof(machine_state, cr3), 8u),
        vm_memory_load(state + offsetof(machine_state, cr4), 8u),
        vm_memory_load(state + offsetof(machine_state, efer), 8u),
        (pl_u32)vm_memory_load(state + offsetof(machine_state, system)
                              + MACHINE_SYSTEM_CS * 8u, 8u) & 3u,
    };
    return vm_mmu_access(&resident, port - arena_base, &context, address, bytes, access, value);
}

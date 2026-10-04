/* Linux legacy 64-bit bzImage entry; no decompression or instruction execution. */
#ifndef VM_BOOT_H
#define VM_BOOT_H
#include <machine/state.h>
#include <machine/segments.h>

enum vm_boot_page_kind {
    VM_BOOT_ZERO = 0, VM_BOOT_METADATA, VM_BOOT_KERNEL, VM_BOOT_INITRAMFS,
    VM_BOOT_ROM, VM_BOOT_IMAGE,
};
typedef struct {
    const pl_u8 *header;
    const pl_u8 *command;
    pl_u32 header_end;
    pl_u32 command_bytes;
    pl_u64 ram_bytes;
    pl_u64 kernel_offset;
    pl_u64 kernel_bytes;
    pl_u64 kernel_address;
    pl_u64 kernel_reservation;
    pl_u64 initramfs_bytes;
    pl_u64 initramfs_address;
    pl_u64 image_address;
    pl_u64 image_bytes;
} vm_boot;
typedef struct {
    pl_u64 offset; /* authenticated object's coordinate, not a URL */
    pl_u32 bytes;
    pl_u32 kind;
} vm_boot_source;

/* Borrow the authenticated first image page and command until close. Object
 * identity/authentication is the caller's Artifact/Storage obligation, not a
 * magic-number check. All output objects must be disjoint from borrowed input.
 * Rejecting reopen clears the old plan. The baseline supplies <1 GiB RAM and
 * uses preferred_address; no EFI, BIOS, above-4G or 32-bit entry is fabricated. */
int vm_boot_open(vm_boot *boot, const pl_u8 *header, pl_u32 header_bytes,
                  pl_u64 image_bytes, pl_u64 initramfs_bytes, pl_u64 ram_bytes,
                  const pl_u8 *command, pl_u32 command_bytes);
/* Attach one authenticated immutable image before any boot projection. Its
 * page-aligned physical extent is outside ordinary RAM, below 1 GiB and at
 * most 256 MiB. E820 reserves its rounded extent; Linux owns the device and
 * filesystem interpretation. No payload is borrowed or materialized here.
 * Immutability describes the source object, not the guest bus: the supplied
 * page is writable private RAM/COW, as with a physical phram image loader.
 * Linux's read-only lower mount controls filesystem writes, not this loader.
 * Invalid attachment clears the previous image, not the kernel boot plan.
 * The serialized caller pins this plan after projection; the Wasm loader
 * rejects attachment once any page/state has been projected or RAM opened. */
int vm_boot_attach_image(vm_boot *boot, pl_u64 address, pl_u64 bytes);
/* For ZERO/METADATA/ROM, write exactly one page. For source pages, return a bounded
 * object extent without touching target: the caller authenticates/copies that
 * extent and zeroes only its final padding. Never reconstruct the whole image.
 * Unmapped physical addresses fail, rather than masquerading as zero RAM.
 * The direct-entry platform exposes erased (0xff) reserved ROM in the range
 * [0xc0000,0x100000), with no SMBIOS/ACPI/MP/option-ROM tables or BIOS service.
 * Writes to admitted ROM are discarded by physical memory, not guest #PF.
 * The VGA/device window 0xa0000..0xc0000 remains unassigned. Neither region is
 * RAM in E820. ROM is reconstructible immutable machine state, not dirty COW.
 * This projects INITIAL content only: it is not a post-execution cache-miss
 * resolver. Dirty/COW and suspend state must never be replaced by these zeros. */
int vm_boot_page(const vm_boot *boot, pl_u64 address, pl_u8 *target,
                  vm_boot_source *source);
int vm_boot_state(const vm_boot *boot, machine_state *state);
int vm_boot_segments(const vm_boot *boot, machine_segments *segments);
#endif

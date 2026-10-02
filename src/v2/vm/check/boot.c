#include <vm/boot.h>
#include <vm/mmu.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static _Alignas(8) pl_u8 arena[65536], page[4096], header[4096];
static int failures;
static vm_memory_branch branches[3];
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "boot: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u8 *at, pl_u64 value, pl_u32 bytes)
{ for (pl_u32 i = 0u; i < bytes; ++i) at[i] = (pl_u8)(value >> (8u * i)); }
static pl_u64 get(const pl_u8 *at, pl_u32 bytes)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < bytes; ++i) value |= (pl_u64)at[i] << (8u * i);
    return value;
}
static long size(FILE *file)
{
    long bytes;
    return !fseek(file, 0, SEEK_END) && (bytes = ftell(file)) > 0
        && !fseek(file, 0, SEEK_SET) ? bytes : -1;
}
static int write_record(const char *prefix, const char *suffix, const void *data, size_t bytes)
{
    char path[4096];
    int length = snprintf(path, sizeof path, "%s.%s", prefix, suffix);
    if (length < 1 || (size_t)length >= sizeof path) return 0;
    FILE *file = fopen(path, "wbx");
    if (!file) return 0;
    int okay = fwrite(data, 1u, bytes, file) == bytes;
    if (fclose(file)) okay = 0;
    return okay;
}
int main(int argc, char **argv)
{
    static const pl_u8 command[] = "console=ttyS0 nokaslr";
    vm_boot boot;
    vm_boot_source source;
    machine_state state;
    machine_segments segments;
    pl_u64 image_bytes = 0x2ea400u, initramfs_bytes = 0x65432u;
    FILE *image = NULL, *initramfs = NULL;
    if (argc != 1 && argc != 3 && argc != 4 && argc != 5) return 2;
    header[0x1f1u] = 31u; header[0x200u] = 0xebu; header[0x201u] = 0x6au;
    put(header + 0x1feu, 0xaa55u, 2u); put(header + 0x202u, 0x53726448u, 4u);
    put(header + 0x206u, 0x20fu, 2u); header[0x211u] = 1u; header[0x236u] = 1u;
    put(header + 0x1f4u, 0x2e640u, 4u); put(header + 0x230u, 0x200000u, 4u);
    put(header + 0x258u, 0x1000000u, 8u); put(header + 0x260u, 0xe62000u, 4u);
    put(header + 0x22cu, 0x37ffffffu, 4u); put(header + 0x238u, 2047u, 4u);
    if (argc >= 3) {
        image = fopen(argv[1], "rb"); initramfs = fopen(argv[2], "rb");
        if (!image || !initramfs) goto failed;
        long a = size(image), b = size(initramfs);
        if (a < 4096 || b < 1 || fread(header, 1u, 4096u, image) != 4096u) goto failed;
        image_bytes = (pl_u64)(unsigned long)a; initramfs_bytes = (pl_u64)(unsigned long)b;
    }
    EXPECT(vm_boot_open(&boot, header, sizeof header, image_bytes, initramfs_bytes,
                        0x8000000u, command, sizeof command - 1u) == 0);
    if (!boot.header) goto failed;
    EXPECT(vm_boot_state(&boot, &state) == 0);
    EXPECT(vm_boot_segments(&boot,&segments) == 0);
    EXPECT(segments.version == MACHINE_SEGMENTS_ABI_VERSION && !segments.mov_ss_shadow);
    EXPECT(segments.cache[MACHINE_SEGMENT_CS].attributes == 0xa09bu);
    EXPECT(segments.cache[MACHINE_SEGMENT_SS].attributes == 0xc093u);
    EXPECT(state.rip == boot.kernel_address + 0x200u && state.registers[6] == 0x1000u);
    EXPECT(state.system[MACHINE_SYSTEM_CS] == 16u && !(state.rflags & 0x600u));
    EXPECT(state.cr3 == 0x4000u && state.cr4 == 32u && state.efer == 0x500u);
    EXPECT(vm_boot_page(&boot, 0x1000u, page, &source) == VM_BOOT_METADATA);
    EXPECT(page[0x210u] == 0xffu && page[0x1e8u] == 3u);
    EXPECT(get(page + 0x214u, 4u) == boot.kernel_address);
    EXPECT(get(page + 0x218u, 4u) == boot.initramfs_address);
    EXPECT(get(page + 0x21cu, 4u) == initramfs_bytes);
    EXPECT(get(page + 0x228u, 4u) == 0x2000u);
    EXPECT(get(page + 0x2f8u, 8u) == 0x100000u); /* third E820 base */
    EXPECT(vm_boot_page(&boot, 0x2000u, page, &source) == VM_BOOT_METADATA);
    EXPECT(!memcmp(page, command, sizeof command));
    memset(page, 0xa5, sizeof page);
    EXPECT(vm_boot_page(&boot, boot.kernel_address, page, &source) == VM_BOOT_KERNEL);
    EXPECT(source.offset == boot.kernel_offset && source.bytes == 4096u);
    for (pl_u32 i = 0u; i < 4096u; ++i) EXPECT(page[i] == 0xa5u);
    EXPECT(vm_boot_page(&boot, boot.initramfs_address, page, &source) == VM_BOOT_INITRAMFS);
    EXPECT(source.offset == 0u && source.bytes == (initramfs_bytes < 4096u ? initramfs_bytes : 4096u));
    EXPECT(vm_boot_page(&boot, 0xa0000u, page, &source) == -1);
    EXPECT(vm_boot_page(&boot, boot.ram_bytes, page, &source) == -1);

    /* Three generated table pages plus the actual first kernel source page.
     * No ELF/root/500-MB RAM materialization or instruction interpreter. */
    vm_memory_page pages[4];
    for (pl_u32 i = 0u; i < 3u; ++i) {
        pages[i] = (vm_memory_page){ 0x4000u + (pl_u64)i * 4096u,
                                     8192u + i * 4096u, 3u, VM_MEMORY_RAM, 0u, 0u };
        EXPECT(vm_boot_page(&boot, pages[i].address, arena + pages[i].offset, &source) == VM_BOOT_METADATA);
    }
    pages[3] = (vm_memory_page){boot.kernel_address, 32768u, 3u, VM_MEMORY_RAM, 0u, 0u};
    if (image) {
        if (fseek(image, (long)boot.kernel_offset, SEEK_SET)
                || fread(arena + 32768u, 1u, 4096u, image) != 4096u) goto failed;
    } else { arena[32768u + 0x200u] = 0xfcu; arena[32768u + 0x201u] = 0xfau; }
    put(arena + 2048u, 9u, 8u);
    vm_memory memory;
    vm_mmu_context context = {state.cr0, state.cr3, state.cr4, state.efer, 0u};
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 4u, branches, 9u) == 0);
    EXPECT(vm_mmu_access(&memory, 2048u, &context, state.rip, 2u, 9u, 0u) == 0u);
    EXPECT(get(arena + 2056u, 2u) == get(arena + 32768u + 0x200u, 2u));
    printf("bzImage plan: entry=%llx kernel=%llu initramfs=%llu initial-opcodes=%04llx; execution/boot NOT tested\n",
           state.rip, boot.kernel_bytes, initramfs_bytes, get(arena + 2056u, 2u));

    if (argc >= 4) {
        if (!write_record(argv[3],"segments",&segments,sizeof segments)) goto failed;
        /* A separate bounded last page, never an expanded bzImage/RAM. It
         * includes the shipped decompressor's GDT and final zero padding. */
        pl_u64 tail = (boot.kernel_bytes - 1u) & ~4095ull;
        if (!image || vm_boot_page(&boot,boot.kernel_address + tail,page,&source) != VM_BOOT_KERNEL
                || fseek(image,(long)source.offset,SEEK_SET)) goto failed;
        memset(page,0,sizeof page);
        if (fread(page,1u,source.bytes,image) != source.bytes
                || !write_record(argv[3],"kernel-last-page",page,sizeof page)) goto failed;
        pl_u8 metadata[6 * 4096];
        for (pl_u32 i = 0u; i < 6u; ++i)
            EXPECT(vm_boot_page(&boot, (pl_u64)(i + 1u) * 4096u,
                                 metadata + i * 4096u, &source) == VM_BOOT_METADATA);
        char json[1024];
        int length = snprintf(json, sizeof json,
            "{\"format\":\"native-bzimage-plan-v1\",\"linuxBoot\":\"not-tested\","
            "\"imageBytes\":%llu,\"initramfsBytes\":%llu,\"ramBytes\":%llu,"
            "\"kernelAddress\":\"%llu\",\"kernelOffset\":%llu,\"entry\":\"%llu\"}\n",
            image_bytes, initramfs_bytes, boot.ram_bytes, boot.kernel_address, boot.kernel_offset, state.rip);
        if (length < 1 || (size_t)length >= sizeof json
                || !write_record(argv[3], "json", json, (size_t)length)
                || !write_record(argv[3], "header", header, sizeof header)
                || !write_record(argv[3], "command", command, sizeof command - 1u)
                || !write_record(argv[3], "state", &state, sizeof state)
                || !write_record(argv[3], "metadata", metadata, sizeof metadata)
                || !write_record(argv[3], "kernel-page", arena + 32768u, 4096u)) goto failed;
        if (argc == 5) {
            char *end = NULL;
            unsigned long long requested = strtoull(argv[4],&end,0);
            if (!argv[4][0] || argv[4][0] == '-' || !end || *end
                    || vm_boot_page(&boot,(pl_u64)requested,page,&source) != VM_BOOT_KERNEL
                    || fseek(image,(long)source.offset,SEEK_SET)) goto failed;
            memset(page,0,sizeof page);
            if (fread(page,1u,source.bytes,image) != source.bytes
                    || !write_record(argv[3],"extra-page",page,sizeof page)) goto failed;
        }
    }

    vm_boot before = boot;
    EXPECT(vm_boot_open(&boot, header, 0x200u, image_bytes, initramfs_bytes,
                        0x8000000u, command, sizeof command - 1u) == -1);
    EXPECT(!boot.header);
    EXPECT(vm_boot_state(&boot, &state) == -1);
    EXPECT(vm_boot_page(&boot, 0x1000u, page, &source) == -1);
    pl_u64 seed = 0x9abc1234u;
    for (pl_u32 i = 0u; i < 100000u; ++i) {
        seed ^= seed << 13u; seed ^= seed >> 7u; seed ^= seed << 17u;
        pl_u32 at = (pl_u32)seed % 0x270u;
        pl_u8 value = header[at]; header[at] ^= (pl_u8)(1u << (seed >> 32u & 7u));
        int result = vm_boot_open(&boot, header, sizeof header, image_bytes, initramfs_bytes,
                                   0x8000000u, command, sizeof command - 1u);
        if (result) EXPECT(!boot.header);
        else {
            EXPECT(boot.kernel_offset + boot.kernel_bytes <= image_bytes);
            EXPECT(boot.kernel_address + boot.kernel_reservation <= boot.initramfs_address);
            EXPECT(boot.initramfs_address + boot.initramfs_bytes <= boot.ram_bytes);
            EXPECT(vm_boot_page(&boot, 0x1000u, page, &source) == VM_BOOT_METADATA);
        }
        header[at] = value;
    }
    boot = before;
    if (image) fclose(image);
    if (initramfs) fclose(initramfs);
    return failures ? 1 : 0;
failed:
    if (image) fclose(image);
    if (initramfs) fclose(initramfs);
    return 1;
}

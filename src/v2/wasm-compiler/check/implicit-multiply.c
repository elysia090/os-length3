#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
extern void native_cut(machine_state *, const void *);
static pl_u8 page[4096], module[65536];
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static int save(const char *directory, pl_u32 form, const char *suffix, const void *data, size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/product-%u.%s",directory,form,suffix);
    if (n<1 || (size_t)n >= sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,bytes,file) == bytes ? 0 : -1;
    if (fclose(file)) status=-1;
    return status;
}
int main(int argc,char **argv)
{
    int observe_only=argc == 3 && !strcmp(argv[2],"--observe");
    if (argc != 1 && argc != 2 && !observe_only) return 2;
    const char *directory=argc >= 2 ? argv[1] : NULL;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if (code == MAP_FAILED) return 1;
    int status=1; pl_u32 observations=0u; pl_u64 seed=0xb5ab987654cd1234ull;
    for (pl_u32 form=0u;form<38u;++form) {
        pl_u32 width=form<32u ? 8u << (form/8u) : form==34u ? 16u : form==35u ? 32u : form==36u ? 8u : 64u;
        pl_u32 signed_product=(form/4u)%2u, variant=form%4u, instructions=form<32u ? 1u : 2u;
        pl_u32 n=0u; memset(page,0x90,sizeof page);
        if (width == 16u) page[n++]=0x66u;
        if (width == 64u) page[n++]=!variant ? 0x49u : 0x48u;
        else if (!variant) page[n++]=0x41u;
        page[n++]=width == 8u ? 0xf6u : 0xf7u;
        page[n++]=(pl_u8)((signed_product ? 0xe8u : 0xe0u)
            | (!variant ? 4u : variant == 1u ? 0u : variant == 2u ? 2u : width == 8u ? 4u : 1u));
        if (form>=32u) {
            /* The second operation reads the first operation's implicit
             * publication; its dead CF/OF must not be materialized early. */
            static const pl_u8 composed[][6]={
                {0x48,0xf7,0xe2,0x48,0xf7,0xe8},
                {0x48,0xf7,0xea,0x48,0xf7,0xe0},
                {0x66,0xf7,0xea,0x66,0xf7,0xe2},
                {0xf7,0xe2,0xf7,0xe9,0x90,0x90},
                {0xf6,0xe4,0xf6,0xec,0x90,0x90},
                {0x48,0xf7,0xe0,0x0f,0x92,0xc1},
            };
            n=form==35u || form==36u ? 4u : 6u;
            memcpy(page,composed[form-32u],n);
        }
        memcpy(code,page,sizeof page); code[n]=0xc3u;
        pl_u64 records[512][35];
        for (pl_u32 row=0u;row<512u;++row) {
            machine_state before={0},actual;
            for (pl_u32 rank=0u;rank<16u;++rank) before.registers[rank]=random_word(&seed);
            before.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 mask=~0ull >> (64u-width),sign=1ull << (width-1u);
            const pl_u64 boundary[]={0u,1u,2u,sign-1u,sign,sign+1u,mask-1u,mask,
                15u,16u,127u,128u,255u,256u,0xffffffffu,0x100000000ull};
            if (form<32u && row<256u) {
                pl_u32 source=!variant ? 12u : variant == 1u ? 0u : variant == 2u ? 2u : width == 8u ? 0u : 1u;
                pl_u32 shift=width == 8u && variant == 3u ? 8u : 0u;
                before.registers[0]=(before.registers[0]&~mask)|(boundary[row/16u]&mask);
                before.registers[source]=(before.registers[source]&~(mask << shift))
                    | ((boundary[row%16u]&mask) << shift);
            }
            actual=before; native_cut(&actual,code); before.registers[4]=actual.registers[4];
            if ((actual.rflags^before.rflags)&~0x8d5ull) goto finish;
            for (pl_u32 rank=0u;rank<16u;++rank) {
                if (rank != 0u && (width == 8u || rank != 2u) && !(form==37u && rank==1u)
                        && actual.registers[rank] != before.registers[rank]) goto finish;
                records[row][rank]=before.registers[rank]; records[row][17u+rank]=actual.registers[rank];
            }
            records[row][16]=before.rflags;
            /* CF/OF are defined; the other four arithmetic flags are not
             * hardware equality requirements. Choose their incoming values. */
            records[row][33]=(actual.rflags&~0xd4ull)|(before.rflags&0xd4u);
            records[row][34]=0x400000u+n; ++observations;
        }
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};
        wasm_cut_options options={image.entry,instructions,sizeof module}; wasm_cut_report report; pl_u64 bytes=0u;
        if (!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if (compiled || report.source_bytes != n || report.source_instructions != instructions
                    || report.memory_bytes || !report.flags_written || report.boundary != WASM_CUT_LIMIT
                    || report.written_registers != (form==37u ? 7u : width == 8u ? 1u : 5u)) {
                fprintf(stderr,"implicit multiply form %u red: compiler=%d\n",form,compiled); goto finish;
            }
        }
        char json[640]; int length=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"moduleBytes\":%llu,\"instructions\":%u,"
            "\"stateBytes\":%zu,\"ripOffset\":%zu,\"flagsOffset\":%zu,\"retiredOffset\":%zu,"
            "\"flagsMask\":\"18446744073709551615\",\"native\":512,\"words\":35}\n",
            form,n,bytes,instructions,sizeof(machine_state),offsetof(machine_state,rip),offsetof(machine_state,rflags),offsetof(machine_state,retired));
        if (length<1 || (size_t)length >= sizeof json || save(directory,form,"json",json,(size_t)length)
                || save(directory,form,"source-page",page,sizeof page) || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)bytes))) goto finish;
    }
    status=0;
finish:
    if (munmap(code,4096u)) status=1;
    if (!status) printf("Implicit products: %u actual x86 observations%s\n",observations,
        observe_only ? "; lowering not tested" : "");
    return status;
}

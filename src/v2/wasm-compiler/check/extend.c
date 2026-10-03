#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
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
    char path[4096]; int n=snprintf(path,sizeof path,"%s/extend-%u.%s",directory,form,suffix);
    if (n < 1 || (size_t)n >= sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,bytes,file) == bytes ? 0 : -1;
    if (fclose(file)) status=-1;
    return status;
}
int main(int argc, char **argv)
{
    int observe_only=argc == 3 && !strcmp(argv[2],"--observe");
    if (argc != 1 && argc != 2 && !observe_only) return 2;
    const char *directory=argc >= 2 ? argv[1] : NULL;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if (code == MAP_FAILED) return 1;
    int status=1; pl_u32 observations=0u; pl_u64 seed=0x987699886644cdabull;
    static const pl_u8 encodings[][2]={{0x66,0x98},{0x98,0},{0x48,0x98},
        {0x66,0x99},{0x99,0},{0x48,0x99}};
    for (pl_u32 form=0u;form<18u;++form) {
        pl_u32 family=form/3u, variant=form%3u, width=16u << (family%3u);
        pl_u32 n=0u, instructions=variant == 2u ? 3u : 1u, high=family >= 3u;
        memset(page,0x90,sizeof page);
        if (variant == 1u) { page[n++]=0x67u; page[n++]=0x64u; }
        if (variant == 2u) { page[n++]=0x48u; page[n++]=0x89u; page[n++]=0xc8u; } /* MOV RAX,RCX */
        pl_u32 conversion=n;
        page[n++]=encodings[family][0];
        if (encodings[family][1]) page[n++]=encodings[family][1];
        if (variant == 2u) { page[n++]=0x49u; page[n++]=0x89u; page[n++]=high ? 0xd2u : 0xc2u; }
        memcpy(code,page,sizeof page); code[n]=0xc3u;
        pl_u64 records[256][34];
        for (pl_u32 row=0u;row<256u;++row) {
            machine_state before={0}, actual;
            for (pl_u32 rank=0u;rank<16u;++rank) before.registers[rank]=random_word(&seed);
            before.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u32 bits=high ? width : width/2u;
            pl_u64 mask=bits == 64u ? ~0ull : (1ull << bits)-1u, sign=1ull << (bits-1u);
            const pl_u64 boundary[]={0u,1u,sign-1u,sign,sign+1u,mask-1u,mask,2u};
            if (row<128u) {
                pl_u32 source=variant == 2u ? 1u : 0u;
                before.registers[source]=(before.registers[source]&~mask)|boundary[row%8u];
            }
            actual=before; native_cut(&actual,code);
            /* The oracle observes its real CALL stack, not a simulated RSP. */
            before.registers[4]=actual.registers[4];
            machine_state wanted=before;
            if (variant == 2u) wanted.registers[0]=before.registers[1];
            pl_u64 value=wanted.registers[0]&mask;
            value=high ? 0ull-((value >> (bits-1u))&1u) : (value^sign)-sign;
            pl_u64 output_mask=width == 64u ? ~0ull : (1ull << width)-1u;
            pl_u32 destination=high ? 2u : 0u;
            wanted.registers[destination]=(width == 16u ? wanted.registers[destination]&~output_mask : 0u)
                | (value&output_mask);
            if (variant == 2u) wanted.registers[10]=wanted.registers[destination];
            for (pl_u32 rank=0u;rank<16u;++rank) {
                if (actual.registers[rank] != wanted.registers[rank]) {
                    fprintf(stderr,"extension native form=%u row=%u register=%u\n",form,row,rank); goto finish;
                }
                records[row][rank]=before.registers[rank]; records[row][17u+rank]=actual.registers[rank];
            }
            if (actual.rflags != before.rflags) goto finish;
            records[row][16]=before.rflags; records[row][33]=actual.rflags; ++observations;
        }
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};
        pl_x86_instruction decoded;
        if (pl_x86_decode(&image,image.entry+conversion,&decoded)
                || decoded.operation != (high ? PL_X86_OPERATION_HIGH_EXTEND : PL_X86_OPERATION_ACCUMULATOR_EXTEND)
                || decoded.operand_width != width || decoded.condition != family%3u
                || decoded.visible_operand_count) goto finish;
        wasm_cut_options options={image.entry,instructions,sizeof module};
        wasm_cut_report report; pl_u64 bytes=0u;
        if (!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if (compiled || report.source_instructions != instructions || report.source_bytes != n
                    || report.flags_written || report.memory_bytes || report.continuation != image.entry+n) {
                fprintf(stderr,"extension form %u red: compiler=%d\n",form,compiled); goto finish;
            }
            /* LOCK is invalid, never a successfully emitted conversion. */
            pl_u8 locked[4096]; memcpy(locked,page,sizeof locked); locked[0]=0xf0u;
            locked[1]=encodings[family][0]; locked[2]=encodings[family][1];
            pl_x86_map invalid=map; invalid.bytes=locked; pl_x86_image bad={&invalid,1u,0u,image.entry};
            pl_u64 unchanged=77u; wasm_cut_report saved; memset(&saved,0xa5,sizeof saved);
            pl_u8 output[4096]; memset(output,0xa5,sizeof output);
            wasm_cut_options one={image.entry,1u,sizeof output};
            if (wasm_compiler_emit_code_cut(&bad,9u,&one,output,sizeof output,&unchanged,&saved) != WASM_COMPILER_ERROR_GRAMMAR
                    || unchanged != 77u) goto finish;
            for (size_t rank=0u;rank<sizeof output;++rank) if (output[rank] != 0xa5u) goto finish;
            for (size_t rank=0u;rank<sizeof saved;++rank) if (((const pl_u8 *)&saved)[rank] != 0xa5u) goto finish;
        }
        char json[256]; int length=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"instructions\":%u,\"native\":256,\"words\":34}\n",
            form,n,instructions);
        if (length < 1 || (size_t)length >= sizeof json || save(directory,form,"json",json,(size_t)length)
                || save(directory,form,"source-page",page,sizeof page) || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)bytes))) goto finish;
    }
    status=0;
finish:
    if (munmap(code,4096u)) status=1;
    if (!status) printf("Sign extensions: %u actual x86 complete-GPR/flags observations%s\n",observations,
        observe_only ? "; lowering not tested" : "");
    return status;
}

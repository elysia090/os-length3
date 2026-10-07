#include "module-interface.h"
#include "cut-internal.h"

void cut_call(cut_lowering *cut,pl_u32 import)
{
    if(import>=WASM_IMPORT_COUNT){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut->imports_used|=1u<<import;
    pl_u32 slot=cut->import_slots?cut->import_slots[import]:import;
    /* An unmapped body is only a measure, never executable output. */
    if(slot==~0u || (!cut->import_slots && cut->writer->bytes)) {
        cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;
    }
    cut_op(cut,0x10u);wasm_writer_uleb(cut->writer,slot);
}

enum { I32=0x7f,I64=0x7e };
typedef struct { pl_u8 count,parameter[5]; } signature;
typedef struct { const char *name;signature type; } machine_import;
static const signature entry_type={4u,{I32,I32,I64,I32}};
static const machine_import interface[WASM_IMPORT_COUNT]={
    {"access",{5u,{I32,I64,I32,I32,I64}}},
    {"reserve",{4u,{I32,I64,I32,I32}}},
    {"commit",{2u,{I32,I64}}},
    {"write_begin",{4u,{I32,I64,I32,I32}}},
    {"write_word",{4u,{I32,I32,I32,I64}}},
    {"write_end",{1u,{I32}}},
    {"segment",{3u,{I32,I32,I32}}},
    {"reserve_pair",{4u,{I32,I64,I32,I32}}},
    {"commit_pair",{3u,{I32,I64,I64}}},
    {"table",{4u,{I32,I64,I32,I32}}},
    {"read_pair",{4u,{I32,I64,I32,I32}}},
    {"read_extent",{4u,{I32,I64,I32,I32}}},
    {"far_return",{2u,{I32,I32}}},
    {"control",{3u,{I32,I32,I64}}},
    {"iret",{1u,{I32}}},
    {"msr",{4u,{I32,I32,I32,I64}}},
    {"debug",{4u,{I32,I32,I32,I64}}},
    {"io",{4u,{I32,I32,I32,I64}}},
    {"time",{1u,{I32}}},
    {"interrupt_flag",{2u,{I32,I32}}},
    {"software_interrupt",{3u,{I32,I32,I64}}},
    {"system_transfer",{3u,{I32,I32,I64}}}
};
static pl_u32 text_bytes(const char *text)
{ pl_u32 bytes=0u;while(text[bytes])++bytes;return bytes; }
static void name(wasm_writer *writer,const char *text)
{
    pl_u32 bytes=text_bytes(text);wasm_writer_uleb(writer,bytes);
    for(pl_u32 i=0u;i<bytes;++i)wasm_writer_byte(writer,(pl_u8)text[i]);
}
static void section(wasm_writer *writer,pl_u32 id,pl_u64 bytes)
{ wasm_writer_byte(writer,id);wasm_writer_uleb(writer,bytes); }
pl_u32 wasm_uleb_bytes(pl_u64 value)
{ pl_u32 bytes=1u;while((value>>=7u))++bytes;return bytes; }
void wasm_import_map(pl_u32 mask,pl_u32 slots[WASM_IMPORT_COUNT])
{
    pl_u32 next=0u;
    for(pl_u32 i=0u;i<WASM_IMPORT_COUNT;++i)
        slots[i]=(mask&(1u<<i))?next++:~0u;
}
pl_u32 wasm_import_count(pl_u32 mask)
{ return (pl_u32)__builtin_popcount(mask&WASM_IMPORT_MASK); }
static int same_type(const signature *a,const signature *b)
{
    if(a->count!=b->count)return 0;
    for(pl_u32 i=0u;i<a->count;++i)if(a->parameter[i]!=b->parameter[i])return 0;
    return 1;
}
static pl_u32 admit_type(signature types[WASM_IMPORT_COUNT+1u],pl_u32 *count,const signature *type)
{
    for(pl_u32 i=0u;i<*count;++i)if(same_type(types+i,type))return i;
    types[*count]=*type;return (*count)++;
}
static void export_name(wasm_writer *writer,pl_u32 ordinal,pl_u32 count)
{
    if(count==1u){name(writer,"cut");return;}
    pl_u8 digits[10];pl_u32 n=0u;
    do {digits[n++]=(pl_u8)('0'+ordinal%10u);ordinal/=10u;}while(ordinal);
    wasm_writer_uleb(writer,4u+n);
    const char *prefix="cut.";for(pl_u32 i=0u;i<4u;++i)wasm_writer_byte(writer,(pl_u8)prefix[i]);
    while(n)wasm_writer_byte(writer,digits[--n]);
}
static void type_section(wasm_writer *writer,const signature *types,pl_u32 count)
{
    wasm_writer_uleb(writer,count);
    for(pl_u32 i=0u;i<count;++i){
        wasm_writer_byte(writer,0x60u);wasm_writer_uleb(writer,types[i].count);
        for(pl_u32 p=0u;p<types[i].count;++p)wasm_writer_byte(writer,types[i].parameter[p]);
        wasm_writer_byte(writer,1u);wasm_writer_byte(writer,I64);
    }
}
static void import_section(wasm_writer *writer,pl_u32 mask,const pl_u32 *type_ranks)
{
    wasm_writer_uleb(writer,1u+wasm_import_count(mask));
    name(writer,"machine");name(writer,"memory");
    wasm_writer_byte(writer,2u);wasm_writer_byte(writer,0u);wasm_writer_byte(writer,1u);
    for(pl_u32 i=0u;i<WASM_IMPORT_COUNT;++i)if(mask&(1u<<i)){
        name(writer,"machine");name(writer,interface[i].name);
        wasm_writer_byte(writer,0u);wasm_writer_uleb(writer,type_ranks[i]);
    }
}
static void function_section(wasm_writer *writer,pl_u32 count,pl_u32 type)
{
    wasm_writer_uleb(writer,count);
    for(pl_u32 i=0u;i<count;++i)wasm_writer_uleb(writer,type);
}
static void export_section(wasm_writer *writer,pl_u32 count,pl_u32 imports,const pl_u16 *ranks)
{
    wasm_writer_uleb(writer,count);
    for(pl_u32 i=0u;i<count;++i){
        export_name(writer,i,count);wasm_writer_byte(writer,0u);wasm_writer_uleb(writer,imports+(ranks?ranks[i]:i));
    }
}
void wasm_module_alias_prefix(wasm_writer *writer,pl_u32 imports,pl_u32 functions,
    pl_u32 exports,const pl_u16 *body_ranks,pl_u64 code_payload_bytes)
{
    if(!writer || imports&~WASM_IMPORT_MASK || !functions){
        if(writer)writer->error=WASM_COMPILER_ERROR_INPUT;
        return;
    }
    signature types[WASM_IMPORT_COUNT+1u];pl_u32 ranks[WASM_IMPORT_COUNT]={0},type_count=0u;
    for(pl_u32 i=0u;i<WASM_IMPORT_COUNT;++i)if(imports&(1u<<i))
        ranks[i]=admit_type(types,&type_count,&interface[i].type);
    pl_u32 entry=admit_type(types,&type_count,&entry_type);
    static const pl_u8 magic[]={0u,0x61u,0x73u,0x6du,1u,0u,0u,0u};
    for(pl_u32 i=0u;i<sizeof magic;++i)wasm_writer_byte(writer,magic[i]);
    wasm_writer measured={.capacity=~0ull};
    type_section(&measured,types,type_count);section(writer,1u,measured.used);type_section(writer,types,type_count);
    measured.used=0u;import_section(&measured,imports,ranks);section(writer,2u,measured.used);import_section(writer,imports,ranks);
    measured.used=0u;function_section(&measured,functions,entry);section(writer,3u,measured.used);function_section(writer,functions,entry);
    measured.used=0u;export_section(&measured,exports,wasm_import_count(imports),body_ranks);section(writer,7u,measured.used);
    export_section(writer,exports,wasm_import_count(imports),body_ranks);
    section(writer,10u,code_payload_bytes);wasm_writer_uleb(writer,functions);
}
void wasm_module_prefix(wasm_writer *writer,pl_u32 imports,pl_u32 functions,pl_u64 code_payload_bytes)
{wasm_module_alias_prefix(writer,imports,functions,functions,0,code_payload_bytes);}

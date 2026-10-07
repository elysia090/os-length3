#include "cut-internal.h"
#include <machine/module.h>
#include <support/checked.h>
static const pl_u8 name[]=MACHINE_IMAGE_SECTION;
static void bytes(wasm_writer *writer,const pl_u8 *source,pl_u32 count)
{for(pl_u32 i=0u;i<count;++i)wasm_writer_byte(writer,source[i]);}
int cut_image_metadata_measure(const wasm_cut_options *cuts,const cut_body_extent *bodies,
    pl_u32 count,cut_image_metadata *metadata)
{
    cut_image_metadata made={0};
    for(pl_u32 first=0u;first<count;){
        pl_u32 end=first+1u;while(end<count && cuts[end].entry==cuts[end-1u].entry+1u)++end;
        if(made.ranges==MACHINE_IMAGE_MAX_RANGES)return WASM_COMPILER_ERROR_CAPACITY;
        pl_u64 last=0u;
        for(pl_u32 i=first;i<end;++i){pl_u64 next;
            if(!bodies[i].span || bodies[i].span>15u || !pl_checked_add_u64(cuts[i].entry,bodies[i].span,&next))
                return WASM_COMPILER_ERROR_GRAMMAR;
            if(next>last)last=next;}
        pl_u64 witness=last-cuts[first].entry;
        if(witness>end-first+14u)return WASM_COMPILER_ERROR_GRAMMAR;
        made.range[made.ranges].first=(pl_u16)first;made.range[made.ranges].count=(pl_u16)(end-first);
        made.range[made.ranges++].witness=(pl_u16)witness;made.witness_bytes+=(pl_u32)witness;first=end;
    }
    made.payload_bytes=wasm_uleb_bytes(sizeof name-1u)+(pl_u32)sizeof name-1u+MACHINE_IMAGE_HEADER_BYTES
        +made.ranges*MACHINE_IMAGE_RANGE_BYTES+(count+1u)/2u+made.witness_bytes;
    *metadata=made;return 0;
}
int cut_image_metadata_emit(wasm_writer *writer,const cut_image_metadata *metadata,
    const wasm_cut_options *cuts,const cut_body_extent *bodies,pl_u32 count,
    const pl_x86_image *source,const pl_u8 digest[32])
{
    wasm_writer_byte(writer,0u);wasm_writer_uleb(writer,metadata->payload_bytes);
    wasm_writer_uleb(writer,sizeof name-1u);bytes(writer,name,sizeof name-1u);
    pl_u8 header[MACHINE_IMAGE_HEADER_BYTES]={0};
    pl_write_u32(header,MACHINE_IMAGE_VERSION);pl_write_u32(header+4u,MACHINE_ABI_VERSION);
    pl_write_u32(header+8u,MACHINE_ENTRY_ABI_VERSION);pl_write_u32(header+12u,count);
    pl_write_u32(header+16u,metadata->ranges);pl_write_u32(header+20u,metadata->witness_bytes);
    for(pl_u32 i=0u;i<32u;++i)header[32u+i]=digest[i];
    bytes(writer,header,sizeof header);
    for(pl_u32 i=0u;i<metadata->ranges;++i){pl_u8 row[MACHINE_IMAGE_RANGE_BYTES]={0};
        pl_write_u64(row,cuts[metadata->range[i].first].entry);pl_write_u16(row+8u,metadata->range[i].count);
        pl_write_u16(row+10u,metadata->range[i].witness);bytes(writer,row,sizeof row);}
    for(pl_u32 i=0u;i<count;i+=2u){pl_u32 value=bodies[i].span-1u;
        if(i+1u<count)value|=(bodies[i+1u].span-1u)<<4u;
        wasm_writer_byte(writer,value);}
    for(pl_u32 i=0u;i<metadata->ranges;++i){pl_u8 witness[WASM_CUT_MODULE_MAX_FUNCTIONS+14u];pl_u32 read=0u;
        int status=pl_x86_image_read(source,cuts[metadata->range[i].first].entry,witness,metadata->range[i].witness,&read);
        if(status || read!=metadata->range[i].witness)return WASM_COMPILER_ERROR_FETCH;
        bytes(writer,witness,read);}
    return writer->error;
}

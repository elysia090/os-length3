#include <vm/module.h>
#include <support/checked.h>

static int uleb(const pl_u8 *bytes,pl_u32 end,pl_u32 *at,pl_u32 *out)
{
    pl_u32 value=0u;
    for(pl_u32 n=0u;n<5u;++n){
        if(*at>=end)return 0;
        pl_u32 byte=bytes[(*at)++];
        if(n==4u && byte>15u)return 0;
        value|=(byte&127u)<<(n*7u);
        if(!(byte&128u)){
            if(n && !(byte&127u))return 0; /* This projection has one minimal spelling. */
            *out=value;return 1;
        }
    }
    return 0;
}
static int equal(const pl_u8 *left,const pl_u8 *right,pl_u32 length)
{for(pl_u32 i=0u;i<length;++i)if(left[i]!=right[i])return 0;return 1;}
typedef struct {
    const pl_u8 *header;
    pl_u32 metadata_bytes,code_bytes,functions,exports,imports,entry_index;
    int bias,entry;
} envelope;
static int text(const pl_u8 *bytes,pl_u32 end,pl_u32 *at,const pl_u8 **name,pl_u32 *length)
{
    if(!uleb(bytes,end,at,length) || *length>end-*at)return 0;
    *name=bytes+*at;*at+=*length;return 1;
}
static int limits(const pl_u8 *bytes,pl_u32 end,pl_u32 *at)
{
    pl_u32 flags,minimum,maximum;
    if(!uleb(bytes,end,at,&flags) || flags>1u || !uleb(bytes,end,at,&minimum))return 0;
    return !flags || (uleb(bytes,end,at,&maximum) && maximum>=minimum);
}
static int projection(const pl_u8 *bytes,pl_u32 length,const pl_u8 *name,pl_u32 name_length,int image,envelope *out)
{
    static const pl_u8 magic[]={0u,0x61u,0x73u,0x6du,1u,0u,0u,0u};
    if(!bytes || length<8u || length>MACHINE_SOURCE_MAX_BYTES || !equal(bytes,magic,8u))return VM_MODULE_ERROR_INPUT;
    envelope opened={0};pl_u32 at=8u,code_functions=0u;int saw_functions=0,saw_exports=0,saw_code=0,saw_imports=0;
    while(at<length){
        pl_u32 start=at,kind=bytes[at++],size;
        if(kind>12u || !uleb(bytes,length,&at,&size) || size>length-at)return VM_MODULE_ERROR_INPUT;
        pl_u32 end=at+size,maximum=MACHINE_SOURCE_MAX_FUNCTIONS+(image?1u:0u);
        if(kind==2u){
            pl_u32 count;if(saw_imports || !uleb(bytes,end,&at,&count))return VM_MODULE_ERROR_INPUT;saw_imports=1;
            for(pl_u32 i=0u;i<count;++i){const pl_u8 *module_name,*field_name;pl_u32 module_bytes,field_bytes,type;
                if(!text(bytes,end,&at,&module_name,&module_bytes) || !text(bytes,end,&at,&field_name,&field_bytes) || at>=end)return VM_MODULE_ERROR_INPUT;
                pl_u32 import_kind=bytes[at++];
                if(import_kind==0u){if(!uleb(bytes,end,&at,&type))return VM_MODULE_ERROR_INPUT;++opened.imports;}
                else if(import_kind==2u){if(!limits(bytes,end,&at))return VM_MODULE_ERROR_INPUT;}
                else if(import_kind==3u){
                    if(end-at<2u || bytes[at]!=0x7eu || bytes[at+1u]!=0u || opened.bias
                        || module_bytes!=7u || !equal(module_name,(const pl_u8 *)"machine",7u)
                        || field_bytes!=10u || !equal(field_name,(const pl_u8 *)"image_bias",10u))return VM_MODULE_ERROR_INPUT;
                    at+=2u;opened.bias=1;
                }else return VM_MODULE_ERROR_INPUT;
            }
            if(at!=end)return VM_MODULE_ERROR_INPUT;
        }else if(kind==3u || kind==10u){pl_u32 count;
            if(!uleb(bytes,end,&at,&count) || !count || count>maximum)return VM_MODULE_ERROR_INPUT;
            if(kind==3u){if(saw_functions)return VM_MODULE_ERROR_INPUT;saw_functions=1;opened.functions=count;
                for(pl_u32 i=0u;i<count;++i){pl_u32 type;if(!uleb(bytes,end,&at,&type))return VM_MODULE_ERROR_INPUT;}
            }else{if(saw_code)return VM_MODULE_ERROR_INPUT;saw_code=1;code_functions=count;
                for(pl_u32 i=0u;i<count;++i){pl_u32 body;if(!uleb(bytes,end,&at,&body) || body>end-at)return VM_MODULE_ERROR_INPUT;at+=body;}}
            if(at!=end)return VM_MODULE_ERROR_INPUT;
        }else if(kind==7u){
            if(saw_exports || !uleb(bytes,end,&at,&opened.exports) || !opened.exports || opened.exports>maximum)return VM_MODULE_ERROR_INPUT;
            saw_exports=1;
            for(pl_u32 i=0u;i<opened.exports;++i){const pl_u8 *field;pl_u32 field_bytes,index;
                if(!text(bytes,end,&at,&field,&field_bytes) || at>=end || bytes[at++]!=0u || !uleb(bytes,end,&at,&index))return VM_MODULE_ERROR_INPUT;
                if(field_bytes==5u && equal(field,(const pl_u8 *)"entry",5u)){
                    if(opened.entry)return VM_MODULE_ERROR_INPUT;
                    opened.entry=1;opened.entry_index=index;}
            }
            if(at!=end)return VM_MODULE_ERROR_INPUT;
        }else if(!kind){const pl_u8 *field;pl_u32 field_bytes;
            if(!text(bytes,end,&at,&field,&field_bytes))return VM_MODULE_ERROR_INPUT;
            if(field_bytes==name_length && equal(field,name,name_length)){
                if(end!=length || !saw_functions || !saw_code || !saw_exports || !saw_imports
                    || opened.functions!=code_functions)return VM_MODULE_ERROR_INPUT;
                if(image && (!opened.bias || !opened.entry || opened.entry_index!=opened.imports+opened.functions-1u))return VM_MODULE_ERROR_ABI;
                opened.header=bytes+at;opened.metadata_bytes=end-at;opened.code_bytes=start;*out=opened;return 0;
            }
        }
        at=end;
    }
    return VM_MODULE_ERROR_ABSENT;
}
static vm_module_entry entry(const vm_module *module,pl_u32 rank)
{
    const pl_u8 *row=module->rows+rank*MACHINE_SOURCE_ROW_BYTES;
    return (vm_module_entry){pl_read_u32(row),pl_read_u16(row+4u),pl_read_u16(row+6u),
        pl_read_u16(row+8u),rank,pl_read_u32(row+12u)};
}
int vm_module_open(const pl_u8 *bytes,pl_u32 length,vm_module *out)
{
    static const pl_u8 name[]=MACHINE_SOURCE_SECTION;
    if(!out)return VM_MODULE_ERROR_INPUT;
    envelope layout;
    int status=projection(bytes,length,name,sizeof name-1u,0,&layout);if(status)return status;
    if(layout.metadata_bytes<MACHINE_SOURCE_HEADER_BYTES)return VM_MODULE_ERROR_INPUT;
    const pl_u8 *header=layout.header;
    if(pl_read_u32(header)!=MACHINE_SOURCE_VERSION || pl_read_u32(header+4u)!=MACHINE_ABI_VERSION
            || pl_read_u32(header+8u)!=MACHINE_ENTRY_ABI_VERSION)return VM_MODULE_ERROR_ABI;
    pl_u32 count=pl_read_u32(header+12u),pages=pl_read_u32(header+24u);
    vm_module opened={header+MACHINE_SOURCE_HEADER_BYTES,0,pl_read_u64(header+16u),layout.code_bytes,count,pages};
    if(!opened.generation || count!=layout.exports || layout.functions>count || !pages || pages>2u
            || pl_read_u32(header+28u))return VM_MODULE_ERROR_INPUT;
    pl_u32 row_bytes=count*MACHINE_SOURCE_ROW_BYTES,witness_bytes=pages*4096u;
    if(layout.metadata_bytes!=MACHINE_SOURCE_HEADER_BYTES+row_bytes+witness_bytes)return VM_MODULE_ERROR_INPUT;
    opened.source=opened.rows+row_bytes;
    for(pl_u32 i=0u;i<count;++i){
        vm_module_entry current=entry(&opened,i);
        if(!current.source_bytes || current.source_bytes>4096u || !current.source_instructions
                || current.source_instructions>current.source_bytes || current.limit<current.source_instructions
                || current.limit>1024u || pl_read_u16(opened.rows+i*MACHINE_SOURCE_ROW_BYTES+10u)
                || current.source_offset>=witness_bytes || current.source_bytes>witness_bytes-current.source_offset
                || (i && entry(&opened,i-1u).source_offset>=current.source_offset))return VM_MODULE_ERROR_INPUT;
        if((current.source_offset&4095u)+current.source_bytes>4096u
                && (current.source_bytes>15u || current.source_instructions!=1u))return VM_MODULE_ERROR_INPUT;
    }
    *out=opened;return 0;
}
int vm_module_find(const vm_module *module,pl_u64 generation,pl_u32 offset,pl_u32 limit,vm_module_entry *out)
{
    if(!module || !out || !module->rows || !module->source || !module->count
            || module->count>MACHINE_SOURCE_MAX_FUNCTIONS || !limit || limit>1024u
            || !generation || generation!=module->generation)return VM_MODULE_ERROR_INPUT;
    pl_u32 begin=0u,end=module->count;
    while(begin<end){pl_u32 middle=begin+(end-begin)/2u;if(entry(module,middle).source_offset<offset)begin=middle+1u;else end=middle;}
    if(begin==module->count)return VM_MODULE_ERROR_ABSENT;
    vm_module_entry selected=entry(module,begin);
    if(selected.source_offset!=offset)return VM_MODULE_ERROR_ABSENT;
    if(selected.source_instructions>limit || (selected.limit!=limit && selected.source_instructions==selected.limit))return VM_MODULE_ERROR_SOURCE;
    *out=selected;return 0;
}

static pl_u32 image_length(const vm_image_module *module,pl_u32 rank)
{return 1u+(((pl_u32)module->lengths[rank/2u]>>((rank&1u)*4u))&15u);}
int vm_image_module_open(const pl_u8 *bytes,pl_u32 length,vm_image_module *out)
{
    static const pl_u8 name[]=MACHINE_IMAGE_SECTION;
    if(!out)return VM_MODULE_ERROR_INPUT;
    envelope layout;
    int status=projection(bytes,length,name,sizeof name-1u,1,&layout);if(status)return status;
    if(layout.metadata_bytes<MACHINE_IMAGE_HEADER_BYTES)return VM_MODULE_ERROR_INPUT;
    const pl_u8 *header=layout.header;
    if(pl_read_u32(header)!=MACHINE_IMAGE_VERSION || pl_read_u32(header+4u)!=MACHINE_ABI_VERSION
        || pl_read_u32(header+8u)!=MACHINE_ENTRY_ABI_VERSION)return VM_MODULE_ERROR_ABI;
    pl_u32 count=pl_read_u32(header+12u),ranges=pl_read_u32(header+16u),witness=pl_read_u32(header+20u);
    if(!count || count>MACHINE_SOURCE_MAX_FUNCTIONS || !ranges || ranges>MACHINE_IMAGE_MAX_RANGES
        || layout.exports!=count+1u || layout.functions<2u || layout.functions>count+1u
        || pl_read_u32(header+24u) || pl_read_u32(header+28u))return VM_MODULE_ERROR_INPUT;
    pl_u32 descriptor=ranges*MACHINE_IMAGE_RANGE_BYTES,packed=(count+1u)/2u;
    if(witness>count+14u*ranges || layout.metadata_bytes!=MACHINE_IMAGE_HEADER_BYTES+descriptor+packed+witness)return VM_MODULE_ERROR_INPUT;
    vm_image_module opened={.ranges=header+MACHINE_IMAGE_HEADER_BYTES,.digest=header+32u,
        .code_bytes=layout.code_bytes,.count=count,.range_count=ranges,.witness_bytes=witness};
    opened.lengths=opened.ranges+descriptor;opened.source=opened.lengths+packed;
    if((count&1u) && (opened.lengths[packed-1u]&0xf0u))return VM_MODULE_ERROR_INPUT;
    pl_u32 total=0u,total_witness=0u;pl_u64 prior=0u;
    for(pl_u32 i=0u;i<ranges;++i){const pl_u8 *range=opened.ranges+i*MACHINE_IMAGE_RANGE_BYTES;
        pl_u64 first=pl_read_u64(range),end;pl_u32 n=pl_read_u16(range+8u),w=pl_read_u16(range+10u);
        if(!n || n>count-total || w<n || w>n+14u || pl_read_u32(range+12u)
                || !pl_checked_add_u64(first,n,&end) || (i && first<=prior))return VM_MODULE_ERROR_INPUT;
        pl_u32 required=0u;
        for(pl_u32 local=0u;local<n;++local){pl_u32 span=image_length(&opened,total+local);
            if(span>15u || span>w-local)return VM_MODULE_ERROR_INPUT;
            if(local+span>required)required=local+span;}
        if(w!=required)return VM_MODULE_ERROR_INPUT; /* No unused witness suffix. */
        total+=n;total_witness+=w;prior=end;
    }
    if(total!=count || total_witness!=witness)return VM_MODULE_ERROR_INPUT;
    *out=opened;return 0;
}
int vm_image_module_find(const vm_image_module *module,pl_u64 coordinate,pl_u32 limit,vm_module_entry *out)
{
    if(!module || !out || !module->ranges || !module->lengths || !module->source || !module->count
        || module->count>MACHINE_SOURCE_MAX_FUNCTIONS || !module->range_count || module->range_count>MACHINE_IMAGE_MAX_RANGES)
        return VM_MODULE_ERROR_INPUT;
    if(limit!=1u)return VM_MODULE_ERROR_SOURCE;
    pl_u32 rank=0u,offset=0u;
    for(pl_u32 i=0u;i<module->range_count;++i){const pl_u8 *range=module->ranges+i*MACHINE_IMAGE_RANGE_BYTES;
        pl_u64 first=pl_read_u64(range);pl_u32 n=pl_read_u16(range+8u),w=pl_read_u16(range+10u);
        if(coordinate>=first && coordinate-first<n){pl_u32 local=(pl_u32)(coordinate-first);
            *out=(vm_module_entry){offset+local,image_length(module,rank+local),1u,1u,0u,0u};return 0;}
        rank+=n;offset+=w;
    }
    return VM_MODULE_ERROR_ABSENT;
}

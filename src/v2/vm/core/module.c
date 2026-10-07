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
static vm_module_entry entry(const vm_module *module,pl_u32 rank)
{
    const pl_u8 *row=module->rows+rank*MACHINE_SOURCE_ROW_BYTES;
    return (vm_module_entry){pl_read_u32(row),pl_read_u16(row+4u),pl_read_u16(row+6u),
        pl_read_u16(row+8u),rank,pl_read_u32(row+12u)};
}
int vm_module_open(const pl_u8 *bytes,pl_u32 length,vm_module *out)
{
    static const pl_u8 magic[]={0u,0x61u,0x73u,0x6du,1u,0u,0u,0u};
    static const pl_u8 name[]=MACHINE_SOURCE_SECTION;
    if(!bytes || !out || length<8u || length>MACHINE_SOURCE_MAX_BYTES || !equal(bytes,magic,8u))return VM_MODULE_ERROR_INPUT;
    pl_u32 at=8u,functions=0u,code_functions=0u,exports=0u;int saw_functions=0,saw_code=0,saw_exports=0;
    while(at<length){
        pl_u32 start=at,kind=bytes[at++],size;
        if(kind>12u || !uleb(bytes,length,&at,&size) || size>length-at)return VM_MODULE_ERROR_INPUT;
        pl_u32 end=at+size;
        if(kind==3u || kind==10u){
            pl_u32 count;
            if(!uleb(bytes,end,&at,&count) || !count || count>MACHINE_SOURCE_MAX_FUNCTIONS)return VM_MODULE_ERROR_INPUT;
            if(kind==3u){
                if(saw_functions)return VM_MODULE_ERROR_INPUT;
                saw_functions=1;functions=count;
                for(pl_u32 i=0u;i<count;++i){pl_u32 type;if(!uleb(bytes,end,&at,&type))return VM_MODULE_ERROR_INPUT;}
                if(at!=end)return VM_MODULE_ERROR_INPUT;
            }else{if(saw_code)return VM_MODULE_ERROR_INPUT;saw_code=1;code_functions=count;}
        }else if(kind==7u){
            if(saw_exports || !uleb(bytes,end,&at,&exports) || !exports || exports>MACHINE_SOURCE_MAX_FUNCTIONS)
                return VM_MODULE_ERROR_INPUT;
            saw_exports=1;
            for(pl_u32 i=0u;i<exports;++i){
                pl_u32 name_bytes,index;
                if(!uleb(bytes,end,&at,&name_bytes) || name_bytes>end-at)return VM_MODULE_ERROR_INPUT;
                at+=name_bytes;
                if(at>=end || bytes[at++]!=0u || !uleb(bytes,end,&at,&index))return VM_MODULE_ERROR_INPUT;
            }
            if(at!=end)return VM_MODULE_ERROR_INPUT;
        }else if(!kind){
            pl_u32 name_bytes;
            if(!uleb(bytes,end,&at,&name_bytes) || name_bytes>end-at)return VM_MODULE_ERROR_INPUT;
            if(name_bytes==sizeof name-1u && equal(bytes+at,name,sizeof name-1u)){
                at+=name_bytes;
                if(end!=length || end-at<MACHINE_SOURCE_HEADER_BYTES || !saw_functions || !saw_code || !saw_exports)return VM_MODULE_ERROR_INPUT;
                const pl_u8 *header=bytes+at;
                if(pl_read_u32(header)!=MACHINE_SOURCE_VERSION || pl_read_u32(header+4u)!=MACHINE_ABI_VERSION
                        || pl_read_u32(header+8u)!=MACHINE_ENTRY_ABI_VERSION)return VM_MODULE_ERROR_ABI;
                pl_u32 count=pl_read_u32(header+12u),pages=pl_read_u32(header+24u);
                vm_module opened={header+MACHINE_SOURCE_HEADER_BYTES,0,pl_read_u64(header+16u),start,count,pages};
                if(!opened.generation || count!=exports || functions>count || functions!=code_functions || !pages || pages>2u
                        || pl_read_u32(header+28u))return VM_MODULE_ERROR_INPUT;
                pl_u32 row_bytes=count*MACHINE_SOURCE_ROW_BYTES,witness_bytes=pages*4096u;
                if(end-at!=MACHINE_SOURCE_HEADER_BYTES+row_bytes+witness_bytes)return VM_MODULE_ERROR_INPUT;
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
        }
        at=end;
    }
    return VM_MODULE_ERROR_ABSENT;
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

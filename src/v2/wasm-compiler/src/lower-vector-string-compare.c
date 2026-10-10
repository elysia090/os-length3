#include "cut-internal.h"
enum { LENGTH_A=26u,LENGTH_B=27u,MASK=28u,TEMP=29u };
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void get(cut_lowering *c,pl_u32 n){cut_op(c,0x20u);wasm_writer_uleb(c->writer,n);}
static void set(cut_lowering *c,pl_u32 n){cut_op(c,0x21u);wasm_writer_uleb(c->writer,n);}
static pl_u32 bytes(const pl_x86_vector_string_compare *p){return 1u+(p->control&1u);}
static pl_u32 eq(const pl_x86_vector_string_compare *p){return bytes(p)==1u?0x23u:0x2du;}
static void zero(cut_lowering *c){cut_const(c,0u);simd(c,0x12u);}
static void vector_constant(cut_lowering *c,const pl_u8 data[16]){simd(c,0x0cu);for(pl_u32 b=0u;b<16u;++b)cut_op(c,data[b]);}
static void validity(cut_lowering *c,const pl_x86_vector_string_compare *p,pl_u32 length)
{
    pl_u32 width=bytes(p);pl_u8 indices[16];for(pl_u32 b=0u;b<16u;++b)indices[b]=(pl_u8)(b%width?0u:b/width);
    vector_constant(c,indices);cut_get(c,length);cut_op(c,0xa7u);simd(c,width==1u?0x0fu:0x10u);simd(c,width==1u?0x26u:0x30u);
}
static void broadcast(cut_lowering *c,const pl_x86_vector_string_compare *p,pl_u32 index)
{
    get(c,c->vector_local);get(c,c->vector_local);simd(c,0x0du);
    pl_u32 width=bytes(p);for(pl_u32 b=0u;b<16u;++b)cut_op(c,(pl_u8)(index*width+b%width));
}
static void valid_a(cut_lowering *c,pl_u32 end)
{
    cut_const(c,~0ull);cut_const(c,0u);cut_get(c,LENGTH_A);cut_const(c,end);cut_op(c,0x56u);cut_op(c,0x1bu);simd(c,0x12u);
}
static void shifted(cut_lowering *c,const pl_x86_vector_string_compare *p,pl_u32 local,pl_u32 distance)
{
    pl_u32 shift=distance*bytes(p);get(c,local);zero(c);simd(c,0x0du);
    for(pl_u32 b=0u;b<16u;++b)cut_op(c,(pl_u8)(b+shift<16u?b+shift:16u));
}
static void term(cut_lowering *c,const pl_x86_vector_string_compare *p,pl_u32 index)
{
    pl_u32 width=bytes(p),aggregation=(p->control>>2u)&3u;
    if(aggregation==1u){
        pl_u32 ge=(width==1u?0x2bu:0x35u)+((p->control&2u)?0u:1u),le=(width==1u?0x29u:0x33u)+((p->control&2u)?0u:1u);
        get(c,c->vector_aux);broadcast(c,p,index*2u);simd(c,ge);
        get(c,c->vector_aux);broadcast(c,p,index*2u+1u);simd(c,le);simd(c,0x4eu);valid_a(c,index*2u+1u);simd(c,0x4eu);
        get(c,c->vector_result);simd(c,0x4eu);return;
    }
    broadcast(c,p,index);
    if(aggregation==3u)shifted(c,p,c->vector_aux,index);else get(c,c->vector_aux);
    simd(c,eq(p));
    if(aggregation==3u){
        shifted(c,p,c->vector_result,index);simd(c,0x4eu);valid_a(c,index);simd(c,0x4du);simd(c,0x50u);
        // The architectural triangular comparison has no pairs beyond the
        // 128-bit source window. Those absent pairs are AND identities, not EOS.
        pl_u8 outside[16];for(pl_u32 b=0u;b<16u;++b)outside[b]=(pl_u8)(b/width+index>=16u/width?255u:0u);
        vector_constant(c,outside);simd(c,0x50u);
    }else{valid_a(c,index);simd(c,0x4eu);get(c,c->vector_result);simd(c,0x4eu);}
}
static void reduce(cut_lowering *c,const pl_x86_vector_string_compare *p,pl_u32 first,pl_u32 count)
{
    if(count==1u){term(c,p,first);return;}
    reduce(c,p,first,count/2u);reduce(c,p,first+count/2u,count/2u);simd(c,((p->control>>2u)&3u)==3u?0x4eu:0x50u);
}
static void length(cut_lowering *c,const pl_x86_vector_string_compare *p,pl_u32 right)
{
    pl_u32 n=16u/bytes(p),destination=right?LENGTH_B:LENGTH_A;
    if(p->explicit_length){
        cut_load(c,offsetof(machine_state,registers)+(right?2u:0u)*8u);
        if(p->length_bytes==4u){cut_const(c,32u);cut_op(c,0x86u);cut_const(c,32u);cut_op(c,0x87u);}
        cut_set(c,TEMP);cut_get(c,TEMP);cut_const(c,63u);cut_op(c,0x87u);cut_set(c,destination);
        cut_get(c,TEMP);cut_get(c,destination);cut_op(c,0x85u);cut_get(c,destination);cut_op(c,0x7du);cut_set(c,TEMP);
        cut_get(c,TEMP);cut_const(c,n);cut_get(c,TEMP);cut_const(c,n);cut_op(c,0x54u);cut_op(c,0x1bu);cut_set(c,destination);
    }else{
        get(c,right?c->vector_aux:c->vector_local);zero(c);simd(c,eq(p));simd(c,bytes(p)==1u?0x64u:0x84u);
        cut_i32_const(c,1u<<n);cut_op(c,0x72u);cut_op(c,0x68u);cut_op(c,0xadu);cut_set(c,destination);
    }
}
void cut_lower_vector_string_compare(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_vector_string_compare *p)
{
    cut_sse_guard(c);
    if(p->source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
        c->report.memory_bytes=16u;c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        get(c,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);cut_i32_const(c,c->report.memory_access);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);
        cut_access_value(c);simd(c,0x12u);get(c,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
        wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));simd(c,0x1eu);cut_op(c,1u);
    }else{cut_get(c,0u);simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p->source*16u);}
    set(c,c->vector_aux);cut_get(c,0u);simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p->target*16u);set(c,c->vector_local);
    length(c,p,0u);length(c,p,1u);validity(c,p,LENGTH_B);set(c,c->vector_result);
    pl_u32 aggregation=(p->control>>2u)&3u,n=16u/bytes(p);
    if(aggregation==2u){
        get(c,c->vector_local);get(c,c->vector_aux);simd(c,eq(p));validity(c,p,LENGTH_A);simd(c,0x4eu);get(c,c->vector_result);simd(c,0x4eu);
        validity(c,p,LENGTH_A);get(c,c->vector_result);simd(c,0x50u);simd(c,0x4du);simd(c,0x50u);
    }else reduce(c,p,0u,aggregation==1u?n/2u:n);
    if(p->control&16u){if(p->control&32u){get(c,c->vector_result);simd(c,0x51u);}else simd(c,0x4du);}
    simd(c,bytes(p)==1u?0x64u:0x84u);cut_op(c,0xadu);cut_set(c,MASK);
    cut_get(c,CUT_FLAGS);cut_const(c,~0x8d5ull);cut_op(c,0x83u);
    cut_get(c,MASK);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_op(c,0x84u);
    cut_get(c,LENGTH_B);cut_const(c,n);cut_op(c,0x54u);cut_op(c,0xadu);cut_const(c,6u);cut_op(c,0x86u);cut_op(c,0x84u);
    cut_get(c,LENGTH_A);cut_const(c,n);cut_op(c,0x54u);cut_op(c,0xadu);cut_const(c,7u);cut_op(c,0x86u);cut_op(c,0x84u);
    cut_get(c,MASK);cut_const(c,1u);cut_op(c,0x83u);cut_const(c,11u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,CUT_FLAGS);c->report.flags_written=1u;
    if(p->index_result){
        cut_const(c,n);if(p->control&64u){cut_const(c,63u);cut_get(c,MASK);cut_op(c,0x79u);cut_op(c,0x7du);}
        else{cut_get(c,MASK);cut_op(c,0x7au);}
        cut_get(c,MASK);cut_op(c,0x50u);cut_op(c,0x1bu);cut_set(c,2u);c->report.written_registers|=2u;c->changed_registers|=2u;return;
    }
    cut_get(c,0u);cut_get(c,MASK);
    if(p->control&64u){
        cut_op(c,0xa7u);simd(c,0x10u);
        if(bytes(p)==1u){set(c,c->vector_local);get(c,c->vector_local);get(c,c->vector_local);simd(c,0x0du);
            for(pl_u32 b=0u;b<16u;++b)cut_op(c,(pl_u8)(b<8u?0u:1u));}
        pl_u8 powers[16];for(pl_u32 b=0u;b<16u;++b)powers[b]=(pl_u8)((1u<<(b/bytes(p)%8u))>>(8u*(b%bytes(p))));
        vector_constant(c,powers);simd(c,0x4eu);zero(c);simd(c,bytes(p)==1u?0x24u:0x2eu);
    }else{simd(c,0x12u);cut_const(c,0u);simd(c,0x1eu);cut_op(c,1u);}
    simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm));
}

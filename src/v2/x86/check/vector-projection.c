#include <x86/semantics.h>
#include <stdio.h>
#include <string.h>

static int form(pl_u32 family, pl_u32 control, pl_u32 location,
                 pl_x86_instruction *instruction)
{
    pl_u8 code[16] = {0};
    pl_u32 at = 0u;
    if (family != 1u) code[at++] = family == 0u||family==6u ? 0x66u : family == 3u ? 0xf2u : 0xf3u;
    code[at++] = 0x0fu;
    code[at++] = family == 1u||family==6u ? 0xc6u : family == 4u ? 0x16u : family == 5u ? 0x12u : 0x70u;
    code[at++] = location == 2u ? 0x00u : location == 1u ? 0xc0u : 0xc1u;
    if (family < 4u||family==6u) code[at++] = (pl_u8)control;
    pl_x86_map map = {code, 0x400000u, at, at, PL_ELF_FLAG_EXECUTE, 1u};
    pl_x86_image image = {&map, 1u, 0u, map.address};
    return pl_x86_decode_profile(&image, map.address, instruction);
}

int main(void)
{
    pl_u32 cases = 0u, refusals = 0u;
    for(pl_u32 left=0u;left<2u;++left)for(pl_u32 count=0u;count<256u;++count)
        for(pl_u32 target=0u;target<16u;++target) {
            pl_u8 code[16]={0};pl_u32 at=0u;code[at++]=0x66u;
            if(target>=8u)code[at++]=0x41u;
            code[at++]=0x0fu;code[at++]=0x73u;
            code[at++]=(pl_u8)((left?0xf8u:0xd8u)|(target&7u));code[at++]=(pl_u8)count;
            pl_x86_map map={code,0x400000u,at,at,PL_ELF_FLAG_EXECUTE,1u};
            pl_x86_image image={&map,1u,0u,map.address};
            pl_x86_instruction instruction;pl_x86_vector_projection projection;
            if(pl_x86_decode_profile(&image,map.address,&instruction)
                    || !pl_x86_vector_project(&instruction,&projection))return 1;
            pl_u8 input[16],actual[16],expected[16]={0};
            for(pl_u32 byte=0u;byte<16u;++byte)input[byte]=(pl_u8)(byte*11u+7u);
            if(count<16u) {
                if(left)memcpy(expected+count,input,16u-count);
                else memcpy(expected,input+count,16u-count);
            }
            for(pl_u32 byte=0u;byte<16u;++byte) {
                pl_u32 source=pl_x86_vector_project_byte(&projection,byte);
                if(source>=32u)return 1;
                actual[byte]=source<16u?input[source]:0u;
            }
            if(memcmp(actual,expected,16u) || projection.identity!=(count==0u)
                    || projection.inputs!=(count>=16u?0u:count?2u:1u))return 1;
            _Alignas(8) pl_u8 storage[8192];pl_arena arena={storage,sizeof storage,0u};
            pl_x86_semantic semantic;
            if(pl_x86_lower(&instruction,&arena,&semantic))return 1;
            ++cases;
        }
    for (pl_u32 family = 0u; family < 7u; ++family)
        for (pl_u32 control = 0u; control < (family < 4u||family==6u ? 256u : 1u); ++control)
            for (pl_u32 location = 0u; location < 3u; ++location) {
                pl_x86_instruction instruction;
                pl_x86_vector_projection projection;
                if (form(family, control, location, &instruction)
                        || !pl_x86_vector_project(&instruction, &projection)) return 1;
                pl_u8 left[16], right[16], actual[16], expected[16];
                for (pl_u32 i = 0u; i < 16u; ++i) {
                    left[i] = (pl_u8)(i * 11u + 3u);
                    right[i] = (pl_u8)(i * 7u + 129u);
                }
                int paired = (family == 1u||family==6u) && location != 1u;
                const pl_u8 *source = paired ? right : left;
                memcpy(expected, source, sizeof expected);
                pl_u32 bytes = family == 2u || family == 3u ? 2u : 4u;
                pl_u32 start = family == 2u ? 8u : 0u;
                pl_u32 selectors = family == 4u ? 0xf5u : family == 5u ? 0xa0u : control;
                if(family==6u){pl_u32 lo=(control&1u)*2u,hi=((control>>1u)&1u)*2u;
                    selectors=lo|((lo+1u)<<2u)|(hi<<4u)|((hi+1u)<<6u);}
                for (pl_u32 lane = 0u; lane < 4u; ++lane) {
                    const pl_u8 *owner = paired && lane < 2u ? left : source;
                    memcpy(expected + start + lane * bytes,
                           owner + start + ((selectors >> (2u * lane)) & 3u) * bytes, bytes);
                }
                for (pl_u32 byte = 0u; byte < 16u; ++byte) {
                    pl_u32 coordinate = pl_x86_vector_project_byte(&projection, byte);
                    if (coordinate >= 32u) return 1;
                    actual[byte] = coordinate < 16u ? left[coordinate] : right[coordinate - 16u];
                }
                if (memcmp(expected, actual, sizeof actual)
                        || projection.inputs != (paired ? 2u : 1u)
                        || projection.identity != (location == 1u && selectors == 0xe4u))
                    return 1;
                /* The native compiler consumes the same admitted law, not a
                 * second instruction-family shape recognizer. */
                _Alignas(8) pl_u8 storage[8192];
                pl_arena arena = {storage, sizeof storage, 0u};
                pl_x86_semantic semantic;
                if (pl_x86_lower(&instruction, &arena, &semantic)) return 1;
                for (pl_u32 bit = 0u; bit < 64u; ++bit) {
                    pl_x86_instruction changed = instruction;
                    changed.machine_argument ^= 1ull << bit;
                    if (!pl_x86_vector_project(&changed, &projection)) ++refusals;
                }
                if (pl_x86_vector_project_byte(NULL, 0u) != 32u
                        || pl_x86_vector_project_byte(&projection, 16u) != 32u) return 1;
                ++cases;
            }
    printf("shared vector projection: %u decoded laws, %u descriptor refusals\n", cases, refusals);
    return 0;
}

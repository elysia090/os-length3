/* Complete final executable-coordinate inventory; never a program publisher. */
#include "io.h"
#include <wasm-compiler/compiler.h>
#include <stdlib.h>

static void histogram(const char *name,const pl_u64 *counts,pl_u32 count)
{
    printf("],\"%s\":[",name);int comma=0;
    for(pl_u32 i=0u;i<count;++i)if(counts[i]){
        printf("%s{\"operation\":%u,\"unlowered\":%llu}",comma?",":"",i,counts[i]);comma=1;
    }
}

int cli_coverage(const char *input_path)
{
    pl_u64 length=0u;pl_u8 *input=cli_read_file(input_path,&length);
    if(!input)return 1;
    wasm_compiler compiler={0};wasm_coverage_report report;
    int status=wasm_compiler_open(&compiler,input,length);
    if(!status)status=wasm_compiler_coverage(&compiler,&report);
    if(status){free(input);fprintf(stderr,"wasm coverage: refused input (%d)\n",status);return 1;}
    pl_u64 missing=report.unlowered_valid+report.unlowered_faults+report.fetch_demands+report.capacity_refusals;
    printf("{\"format\":\"final-elf-wasm-coverage-v1\",\"domain\":\"every-final-PF_X-byte\","
        "\"inputBytes\":%llu,\"coordinates\":%llu,\"lowerable\":%llu,"
        "\"unloweredValid\":%llu,\"unloweredFaults\":%llu,\"fetchDemands\":%llu,\"capacityRefusals\":%llu,"
        "\"directEdges\":%llu,\"directOutside\":%llu,\"indirectEdges\":%llu,"
        "\"first\":{\"address\":\"0x%llx\",\"status\":%d,\"operation\":%u,\"machineOperation\":%u,"
        "\"decodeStatus\":%u,\"source\":\"",
        length,report.catalog.coordinates,report.lowerable,report.unlowered_valid,report.unlowered_faults,
        report.fetch_demands,report.capacity_refusals,report.catalog.direct_edges,report.catalog.direct_edges_outside_image,
        report.catalog.indirect_edges,report.first_unlowered,report.first_status,report.first_operation,
        report.first_machine_operation,report.first_decode_status);
    for(pl_u32 i=0u;i<report.first_source_bytes;++i)printf("%02x",report.first_source[i]);
    printf("\"},\"operations\":[");int comma=0;
    for(pl_u32 i=0u;i<=PL_X86_OPERATION_MAX;++i)if(report.operations[i]){
        printf("%s{\"operation\":%u,\"unlowered\":%llu}",comma?",":"",i,report.operations[i]);comma=1;
    }
    histogram("machines",report.machine_operations,PL_X86_MACHINE_EXTENSION+1u);
    histogram("x87",report.x87_operations,256u);histogram("vector",report.vector_operations,256u);
    printf("],\"coverageComplete\":%s,\"publicationAllowed\":false,\"linuxBoot\":\"not-tested\"}\n",missing?"false":"true");
    free(input);return missing?3:0;
}

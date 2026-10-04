#include <vm/uart.h>
#include <stdio.h>
#include <string.h>
static vm_uart uart;
static unsigned failures,reads;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"uart: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void write_reg(pl_u32 rank,pl_u32 byte)
{ EXPECT(!vm_uart_transfer(&uart,0u,0x3f8u+rank,1u,&byte)); }
static pl_u32 read_reg(pl_u32 rank)
{ pl_u32 byte=0u;EXPECT(!vm_uart_transfer(&uart,0u,0x3f8u+rank,0u,&byte));++reads;return byte; }
int main(int argc,char **argv)
{
    vm_uart_reset(&uart);
    if(argc==2 && !strcmp(argv[1],"--trace")){
        char kind;unsigned port,byte;
        while(scanf(" %c %u",&kind,&port)==2){
            byte=0u;if(kind=='W' && scanf(" %u",&byte)!=1)return 2;
            int result=vm_uart_transfer(&uart,0u,port,(pl_u32)(kind=='W'),&byte);
            if(result==1)result=vm_uart_transmit_commit(&uart,byte); /* explicit test-only accepted sink */
            if(result)return 2;
            if(kind=='R')printf("%u\n",byte);
        }
        return 0;
    }
    EXPECT(read_reg(1u)==0u && read_reg(2u)==1u && read_reg(4u)==8u && read_reg(5u)==0x60u);
    for(pl_u32 byte=0u;byte<256u;++byte){
        write_reg(7u,byte);EXPECT(read_reg(7u)==byte);
        write_reg(3u,0x80u);write_reg(0u,byte);write_reg(1u,255u-byte);
        EXPECT(read_reg(0u)==byte && read_reg(1u)==255u-byte);write_reg(3u,3u);
        write_reg(1u,byte);EXPECT(read_reg(1u)==(byte&15u));
        write_reg(4u,byte);EXPECT(read_reg(4u)==(byte&31u));
        if(byte&16u)EXPECT(read_reg(6u)==(((byte&12u)<<4u)|((byte&2u)<<3u)|((byte&1u)<<5u)));
    }
    for(pl_u32 threshold=0u;threshold<4u;++threshold){
        vm_uart_reset(&uart);write_reg(4u,16u);write_reg(2u,1u|(threshold<<6u));write_reg(1u,1u);
        const pl_u32 sizes[]={1u,4u,8u,14u};
        for(pl_u32 i=0u;i<16u;++i){write_reg(0u,i);EXPECT((read_reg(2u)&15u)==(i+1u>=sizes[threshold] ? 4u : 1u));}
        write_reg(0u,255u);EXPECT(read_reg(5u)==0x63u);EXPECT(read_reg(5u)==0x61u);
        for(pl_u32 i=0u;i<16u;++i)EXPECT(read_reg(0u)==i);
        EXPECT(read_reg(0u)==0u && read_reg(5u)==0x60u && !vm_uart_irq(&uart));
    }
    vm_uart_reset(&uart);write_reg(4u,16u);write_reg(2u,0xc1u);write_reg(1u,1u);write_reg(0u,7u);
    pl_u64 deadline=uart.deadline;vm_uart_advance(&uart,deadline-1u);EXPECT(!vm_uart_irq(&uart));
    vm_uart_advance(&uart,deadline);EXPECT((read_reg(2u)&15u)==12u && vm_uart_irq(&uart));
    EXPECT(read_reg(0u)==7u && !vm_uart_irq(&uart));
    vm_uart_reset(&uart);write_reg(4u,16u);write_reg(2u,0xc1u);write_reg(1u,1u);
    pl_u32 last=7u;EXPECT(!vm_uart_transfer(&uart,~0ull,0x3f8u,1u,&last));
    vm_uart_advance(&uart,~0ull);EXPECT(!uart.deadline && !uart.timeout && !vm_uart_irq(&uart));
    vm_uart_reset(&uart);write_reg(1u,2u);EXPECT(read_reg(2u)==2u && read_reg(2u)==1u);
    pl_u32 byte=65u;vm_uart before=uart;
    EXPECT(vm_uart_transfer(&uart,0u,0x3f8u,1u,&byte)==1 && !memcmp(&uart,&before,sizeof uart));
    EXPECT(!vm_uart_transmit_commit(&uart,byte) && vm_uart_irq(&uart));
    EXPECT(read_reg(2u)==2u && !vm_uart_irq(&uart));
    for(pl_u32 bad=0u;bad<5u;++bad){
        vm_uart_reset(&uart);vm_uart saved=uart;pl_u32 invalid=bad==2u ? 256u : bad==3u ? 64u : 1u;
        EXPECT(vm_uart_transfer(bad==4u ? NULL : &uart,0u,bad==0u ? 0x3f7u : bad==3u ? 0x3fbu : 0x3ffu,
            bad==1u ? 2u : 1u,&invalid)==-1);
        EXPECT(!memcmp(&uart,&saved,sizeof uart));
    }
    if(failures)return 1;
    printf("C UART: %u register/FIFO/IRQ observations green; external sink and silicon baud fidelity NOT tested\n",reads);
    return 0;
}

#include <vm/uart.h>
void vm_uart_reset(vm_uart *uart)
{ if(uart){*uart=(vm_uart){0};uart->divisor=12u;uart->mcr=8u;} }
int vm_uart_accepts(pl_u32 coordinate)
{ return coordinate>=0x3f8u && coordinate<=0x3ffu; }
static pl_u32 trigger(const vm_uart *uart)
{ const pl_u8 levels[]={1u,4u,8u,14u};return levels[uart->fcr>>6u]; }
static pl_u64 timeout_interval(const vm_uart *uart)
{
    /* Four character times. Half-bit units represent 5-bit/1.5-stop mode
     * without floating point; round the event deadline upward. */
    pl_u32 bits=2u*(1u+5u+(uart->lcr&3u)+((uart->lcr&8u)!=0u));
    bits+=(uart->lcr&4u) ? (uart->lcr&3u) ? 4u : 3u : 2u;
    return uart->divisor ? ((pl_u64)uart->divisor*bits*2000000000ull+115199u)/115200u
        : ((pl_u64)bits*2000000000ull+3499u)/3500u;
}
static void restart(vm_uart *uart,pl_u64 now)
{
    pl_u64 interval=timeout_interval(uart);
    uart->deadline=now>~0ull-interval ? 0u : now+interval;
    uart->timeout=0u;
}
void vm_uart_advance(vm_uart *uart,pl_u64 now)
{ if(uart && (uart->fcr&1u) && uart->count && uart->deadline && now>=uart->deadline)uart->timeout=1u; }
static pl_u32 status(const vm_uart *uart)
{ return 0x60u|uart->errors|(uart->count ? 1u : 0u); }
static pl_u32 interrupt(const vm_uart *uart)
{
    if((uart->ier&4u) && uart->errors)return 6u;
    if((uart->ier&1u) && uart->timeout)return 12u;
    if((uart->ier&1u) && uart->count && (!(uart->fcr&1u) || uart->count>=trigger(uart)))return 4u;
    if((uart->ier&2u) && uart->thre_pending)return 2u;
    return 1u;
}
int vm_uart_irq(const vm_uart *uart)
{ return uart && interrupt(uart)!=1u; }
static void receive(vm_uart *uart,pl_u64 now,pl_u8 byte)
{
    if(uart->fcr&1u){
        if(uart->count==16u)uart->errors|=2u;
        else {uart->rx[(uart->head+uart->count)&15u]=byte;++uart->count;}
        restart(uart,now);
    }else{
        if(uart->count)uart->errors|=2u;
        uart->rbr=byte;uart->count=1u;
    }
}
int vm_uart_transmit_commit(vm_uart *uart,pl_u32 value)
{
    if(!uart || value>255u || (uart->lcr&128u) || (uart->mcr&16u))return -1;
    uart->thre_pending=1u;return 0;
}
int vm_uart_transfer(vm_uart *uart,pl_u64 now,pl_u32 coordinate,pl_u32 write,pl_u32 *value)
{
    if(!uart || !value || !vm_uart_accepts(coordinate) || write>1u || (write && *value>255u))return -1;
    pl_u32 rank=coordinate-0x3f8u,byte=*value;
    if(write && rank==3u && (byte&64u))return -1; /* Break-line transport is not owned yet. */
    /* Transmission is not a successful no-op. The caller must supply an
     * external sink before either the device or guest instruction commits. */
    if(write && !rank && !(uart->lcr&128u) && !(uart->mcr&16u))return 1;
    vm_uart_advance(uart,now);
    if(write){
        switch(rank){
        case 0u:
            if(uart->lcr&128u)uart->divisor=(pl_u16)((uart->divisor&0xff00u)|byte);
            else {receive(uart,now,(pl_u8)byte);uart->thre_pending=1u;}
            break;
        case 1u:
            if(uart->lcr&128u)uart->divisor=(pl_u16)((uart->divisor&255u)|(byte<<8u));
            else {if((uart->ier^byte)&2u)uart->thre_pending=(pl_u8)((byte>>1u)&1u);uart->ier=(pl_u8)(byte&15u);}
            break;
        case 2u:
            if((uart->fcr^byte)&1u)byte|=6u;
            if(byte&2u){uart->head=uart->count=0u;uart->errors&=(pl_u8)~16u;uart->timeout=0u;}
            if(byte&4u)uart->thre_pending=1u;
            uart->fcr=(pl_u8)(byte&0xc9u);break;
        case 3u:uart->lcr=(pl_u8)byte;break;
        case 4u:uart->mcr=(pl_u8)(byte&31u);break;
        case 7u:uart->scratch=(pl_u8)byte;break;
        default:break; /* LSR and MSR are read-only. */
        }
    }else{
        switch(rank){
        case 0u:
            if(uart->lcr&128u)byte=uart->divisor&255u;
            else if(uart->fcr&1u){
                byte=uart->count ? uart->rx[uart->head] : 0u;
                if(uart->count){uart->head=(pl_u8)((uart->head+1u)&15u);--uart->count;}
                if(uart->count)restart(uart,now);else {uart->timeout=0u;uart->errors&=(pl_u8)~16u;}
            }else{byte=uart->rbr;uart->count=0u;uart->errors&=(pl_u8)~16u;}
            break;
        case 1u:byte=uart->lcr&128u ? uart->divisor>>8u : uart->ier;break;
        case 2u:byte=interrupt(uart);if(byte==2u)uart->thre_pending=0u;byte|=uart->fcr&1u ? 0xc0u : 0u;break;
        case 3u:byte=uart->lcr;break;
        case 4u:byte=uart->mcr;break;
        case 5u:byte=status(uart);uart->errors=0u;break;
        case 6u:
            /* Fixed virtual cable inputs outside loopback. The null-backend
             * profile does not model physical modem polling/delta interrupts. */
            byte=uart->mcr&16u ? ((uart->mcr&12u)<<4u)|((uart->mcr&2u)<<3u)|((uart->mcr&1u)<<5u) : 0xb0u;
            break;
        default:byte=uart->scratch;break;
        }
        *value=byte;
    }
    return 0;
}

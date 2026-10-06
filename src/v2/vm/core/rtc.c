#include <vm/rtc.h>
#include "clock-internal.h"

enum { SECOND=0, MINUTE=2, HOUR=4, WEEKDAY=6, DAY=7, MONTH=8, YEAR=9,
    A=10, B=11, C=12, D=13, CENTURY=0x32 };
#define BILLION 1000000000u
static pl_u32 encode(pl_u32 value, pl_u32 binary)
{ return binary ? value : (value/10u)*16u+value%10u; }
static int decode(pl_u32 value, pl_u32 binary)
{
    if (!binary && ((value&15u)>9u || (value>>4u)>9u)) return -1;
    return (int)(binary ? value : (value>>4u)*10u+(value&15u));
}
static int hour(pl_u32 value, pl_u32 mode)
{
    int h=decode(value&127u,mode&4u);
    if (mode&2u) return h>=0 && h<24 && !(value&128u) ? h : -1;
    return h>=1 && h<=12 ? h%12+((value&128u) ? 12 : 0) : -1;
}
/* March-based 400-year eras: bounded integer arithmetic, no year/day scan. */
static pl_u8 calendar_value(pl_u64 seconds, pl_u32 shift, pl_u32 mode, pl_u32 field)
{
    pl_u32 binary=mode&4u, value;
    switch (field) {
    case SECOND: value=(pl_u32)(seconds%60u); break;
    case MINUTE: value=(pl_u32)(seconds/60u%60u); break;
    case HOUR: {
        pl_u32 h=(pl_u32)(seconds/3600u%24u);
        return (pl_u8)((mode&2u) ? encode(h,binary)
            : encode(h%12u ? h%12u : 12u,binary)|(h>=12u ? 128u : 0u));
    }
    case WEEKDAY: value=(pl_u32)((seconds/86400u+4u+shift)%7u)+1u; break;
    default: {
        pl_u64 z=seconds/86400u+719468u, era=z/146097u;
        pl_u32 d=(pl_u32)(z%146097u), y=(d-d/1460u+d/36524u-d/146096u)/365u;
        pl_u32 doy=d-(365u*y+y/4u-y/100u), m=(5u*doy+2u)/153u;
        pl_u32 date=doy-(153u*m+2u)/5u+1u, month=m<10u ? m+3u : m-9u;
        pl_u32 year=(pl_u32)era*400u+y+(month<=2u);
        value=field==DAY ? date : field==MONTH ? month : field==YEAR ? year%100u : year/100u;
        break;
    }
    }
    return (pl_u8)encode(value,binary);
}
static const pl_u8 fields[]={SECOND,MINUTE,HOUR,WEEKDAY,DAY,MONTH,YEAR,CENTURY};
static int calendar_field(pl_u32 index)
{ return (index<10u && ((1u<<index)&0x3d5u)) || index==CENTURY; }
static void calendar(vm_rtc *r)
{
    for (pl_u32 i=0u;i<sizeof fields;++i)
        r->bytes[fields[i]]=calendar_value(r->seconds,r->weekday_shift,r->bytes[B],fields[i]);
}
/* Substitute one incoming byte into the projected calendar. Neither the
 * complete device nor a stale pre-tick calendar is copied for validation. */
static pl_u32 input_value(const vm_rtc *r, pl_u64 projected, int refresh,
    pl_u32 index, pl_u32 byte, pl_u32 field)
{
    if (index==field) return field==SECOND ? byte&127u : byte;
    return refresh ? calendar_value(projected,r->weekday_shift,r->bytes[B],field) : r->bytes[field];
}
static int from_calendar(const vm_rtc *r, pl_u64 projected, int refresh,
    pl_u32 index, pl_u32 byte, pl_u64 *seconds, pl_u8 *shift)
{
    pl_u32 mode=index==B ? byte : r->bytes[B], binary=mode&4u;
#define INPUT(field) input_value(r,projected,refresh,index,byte,field)
    int sec=decode(INPUT(SECOND),binary), min=decode(INPUT(MINUTE),binary);
    int h=hour(INPUT(HOUR),mode), date=decode(INPUT(DAY),binary);
    int m=decode(INPUT(MONTH),binary), y=decode(INPUT(YEAR),binary);
    int century=decode(INPUT(CENTURY),binary), week=decode(INPUT(WEEKDAY),binary);
#undef INPUT
    if (sec<0 || sec>59 || min<0 || min>59 || h<0 || date<1 || date>31
            || m<1 || m>12 || y<0 || y>99 || century<0 || century>99 || week<1 || week>7) return -1;
    y+=century*100; if (y<1970) return -1;
    pl_u32 leap=(pl_u32)(y%4==0 && (y%100!=0 || y%400==0));
    const pl_u8 lengths[12]={31u,28u,31u,30u,31u,30u,31u,31u,30u,31u,30u,31u};
    if ((pl_u32)date>(pl_u32)lengths[m-1]+(m==2 ? leap : 0u)) return -1;
    y-=m<=2; pl_u32 era=(pl_u32)y/400u, yo=(pl_u32)y%400u;
    pl_u32 mp=(pl_u32)(m>2 ? m-3 : m+9), doy=(153u*mp+2u)/5u+(pl_u32)date-1u;
    pl_u64 days=(pl_u64)era*146097u+yo*365u+yo/4u-yo/100u+doy;
    if (days<719468u) return -1;
    *seconds=(days-719468u)*86400u+(pl_u32)h*3600u+(pl_u32)min*60u+(pl_u32)sec;
    *shift=(pl_u8)(((pl_u32)week+6u-(pl_u32)((*seconds/86400u+4u)%7u))%7u);
    return *seconds<=VM_RTC_MAX_SECONDS ? 0 : -1;
}
static int running(const vm_rtc *r) { return (r->bytes[A]&0x70u)==0x20u; }
static pl_u32 period(const vm_rtc *r)
{
    pl_u32 code=r->bytes[A]&15u; if (!code) return 0u;
    if (code<=2u) code+=7u;
    return 1u<<(code-1u);
}
static pl_u64 ticks(pl_u64 ns)
{ return ns/BILLION*32768u+ns%BILLION*32768u/BILLION; }
static int alarm_value(pl_u32 value, pl_u32 mode, pl_u32 is_hour)
{
    if ((value&192u)==192u) return -2;
    int v=is_hour ? hour(value,mode) : decode(value,mode&4u);
    return v>=0 && v<(is_hour ? 24 : 60) ? v : -1;
}
/* Earliest product-of-digits match strictly after 'after', in four fixed
 * lexicographic cases. Elapsed seconds and missed periods are never scanned. */
static pl_u64 next_alarm(const vm_rtc *r, pl_u64 after)
{
    int hs=alarm_value(r->bytes[5],r->bytes[B],1u), ms=alarm_value(r->bytes[3],r->bytes[B],0u);
    int ss=alarm_value(r->bytes[1],r->bytes[B],0u);
    if (hs==-1 || ms==-1 || ss==-1) return ~0ull;
    pl_u32 start=(pl_u32)(after%86400u)+1u, h=start/3600u, m=start/60u%60u, s=start%60u;
    pl_u32 loh=hs==-2 ? 0u : (pl_u32)hs, lom=ms==-2 ? 0u : (pl_u32)ms, los=ss==-2 ? 0u : (pl_u32)ss;
    pl_u32 candidate=86400u+loh*3600u+lom*60u+los;
    if (h<24u) {
        if ((hs==-2 || (pl_u32)hs==h) && (ms==-2 || (pl_u32)ms==m) && (ss==-2 || (pl_u32)ss>=s))
            candidate=h*3600u+m*60u+(ss==-2 ? s : (pl_u32)ss);
        else if ((hs==-2 || (pl_u32)hs==h) && (ms==-2 ? m<59u : (pl_u32)ms>m))
            candidate=h*3600u+(ms==-2 ? m+1u : (pl_u32)ms)*60u+los;
        else if (hs==-2 ? h<23u : (pl_u32)hs>h)
            candidate=(hs==-2 ? h+1u : (pl_u32)hs)*3600u+lom*60u+los;
    }
    return after-after%86400u+candidate;
}
static void irq(vm_rtc *r)
{ r->bytes[C]=(pl_u8)((r->bytes[C]&0x70u)|((r->bytes[C]&r->bytes[B]&0x70u) ? 128u : 0u)); }
void vm_rtc_reset(vm_rtc *r)
{
    if (r) { *r=(vm_rtc){0}; r->bytes[A]=0x26u; r->bytes[B]=2u; }
}
int vm_rtc_seed(vm_rtc *r, pl_u64 seconds)
{
    if (!r || r->seeded || r->used || r->now || seconds>VM_RTC_MAX_SECONDS) return -1;
    r->seconds=seconds; r->seeded=1u; r->bytes[D]=128u; calendar(r); return 0;
}
int vm_rtc_can_advance(const vm_rtc *r, pl_u64 ns)
{
    if (!r || !r->seeded || ns<r->now || r->fraction>=BILLION) return 0;
    if (!running(r)) return 1;
    pl_u64 delta=ns-r->now, carry=((pl_u64)r->fraction+delta%BILLION)/BILLION;
    return r->seconds<=VM_RTC_MAX_SECONDS && delta/BILLION+carry<=VM_RTC_MAX_SECONDS-r->seconds;
}
int vm_rtc_next_irq(const vm_rtc *r,pl_u64 *ns)
{
    if(!r || !ns || !r->seeded || !running(r) || vm_rtc_irq(r)
            || r->now<r->oscillator_origin || r->fraction>=BILLION)return 0;
    pl_u64 next=0u,candidate;int found=0;
    pl_u32 p=period(r);
    if((r->bytes[B]&64u) && p){
        pl_u64 tick=ticks(r->now-r->oscillator_origin);
        tick=tick-tick%p+p;
        if(vm_tick_deadline(tick,32768u,r->oscillator_origin,&candidate)){next=candidate;found=1;}
    }
    if(!(r->bytes[B]&128u)){
        if(r->bytes[B]&16u){
            pl_u64 delta=BILLION-r->fraction;
            if(r->now<=~0ull-delta && (!found || r->now+delta<next)){next=r->now+delta;found=1;}
        }
        if(r->bytes[B]&32u){
            pl_u64 alarm=next_alarm(r,r->seconds);
            if(alarm!=~0ull && alarm>r->seconds){
                pl_u64 delta=(alarm-r->seconds)*BILLION-r->fraction;
                if(r->now<=~0ull-delta && (!found || r->now+delta<next)){next=r->now+delta;found=1;}
            }
        }
    }
    if(!found || !vm_rtc_can_advance(r,next))return 0;
    *ns=next;return 1;
}
int vm_rtc_advance(vm_rtc *r, pl_u64 ns)
{
    if (!vm_rtc_can_advance(r,ns)) return -1;
    if (running(r)) {
        pl_u64 delta=ns-r->now, fraction=r->fraction+delta%BILLION;
        pl_u64 seconds=r->seconds+delta/BILLION+fraction/BILLION;
        pl_u32 p=period(r);
        if (p && ticks(ns-r->oscillator_origin)/p>ticks(r->now-r->oscillator_origin)/p) r->bytes[C]|=64u;
        if (seconds>r->seconds && !(r->bytes[B]&128u)) {
            if (seconds>=next_alarm(r,r->seconds)) r->bytes[C]|=32u;
            r->bytes[C]|=16u;
        }
        r->seconds=seconds; r->fraction=(pl_u32)(fraction%BILLION);
    }
    r->now=ns; irq(r); return 0;
}
int vm_rtc_accepts(const vm_rtc *r, pl_u32 port, pl_u32 write, pl_u32 value)
{
    if (!r || (port!=0x70u && port!=0x71u) || write>1u || value>255u) return 0;
    if (port==0x70u) return 1;
    if (!r->seeded) return 0;
    if (!write) return 1;
    if (r->index==A) return (value&0x70u)==0x20u || (value&0x60u)==0x60u;
    if (r->index==B) return !(value&1u); /* UTC; no legacy DST rule. */
    if (r->index==1u || r->index==3u || r->index==5u)
        return alarm_value(value,r->bytes[B],r->index==5u)!=-1;
    return 1;
}
int vm_rtc_transfer(vm_rtc *r, pl_u64 ns, pl_u32 port, pl_u32 write, pl_u32 *value)
{
    if (!value || !vm_rtc_accepts(r,port,write,*value)) return -1;
    if (port==0x70u) {
        if (write) { r->index=(pl_u8)(*value&127u); r->nmi_mask=(pl_u8)(*value>>7u); }
        else *value=255u; /* Write-only PC address bus floats high on read. */
        r->used=1u; return 0;
    }
    /* Preflight calendar writes before clock/CMOS mutation. SET permits an
     * intermediate incomplete calendar, but clearing SET must validate it. */
    pl_u32 index=r->index==0x37u ? CENTURY : r->index, byte=*value;
    if (!vm_rtc_can_advance(r,ns)) return -1;
    pl_u64 delta=ns-r->now, projected=r->seconds;
    if (running(r)) projected+=delta/BILLION+((pl_u64)r->fraction+delta%BILLION)/BILLION;
    pl_u64 replacement=0u; pl_u8 shift=0u;
    int retime=write && ((index==B && (r->bytes[B]&128u) && !(byte&128u))
        || (calendar_field(index) && !(r->bytes[B]&128u)));
    if (retime) {
        if (from_calendar(r,projected,running(r) && !(r->bytes[B]&128u),index,byte,&replacement,&shift)) return -1;
    }
    if (vm_rtc_advance(r,ns)) return -1;
    if (!write) {
        if (index==A) *value=r->bytes[A]|(running(r) && !(r->bytes[B]&128u)
            && r->fraction>=BILLION-244141u ? 128u : 0u);
        else {
            *value=calendar_field(index) && running(r) && !(r->bytes[B]&128u)
                ? calendar_value(r->seconds,r->weekday_shift,r->bytes[B],index) : r->bytes[index];
            if (index==C) r->bytes[C]=0u;
        }
    } else if (index==A) {
        int reset=(r->bytes[A]&0x60u)==0x60u;
        if (running(r) && !(r->bytes[B]&128u)) calendar(r);
        r->bytes[A]=(pl_u8)(byte&127u);
        if (reset && running(r)) { r->fraction=500000000u; r->oscillator_origin=ns; }
    } else if (index==B) {
        if ((byte&128u) && !(r->bytes[B]&128u) && running(r)) calendar(r);
        r->bytes[B]=(pl_u8)((byte&128u) ? byte&~16u : byte);
    }
    else if (index!=C && index!=D) r->bytes[index]=(pl_u8)(index==SECOND ? byte&127u : byte);
    if (retime) { r->seconds=replacement; r->weekday_shift=shift; if (!running(r)) calendar(r); }
    r->index=(pl_u8)index; r->used=1u; irq(r); return 0;
}
int vm_rtc_irq(const vm_rtc *r) { return r && (r->bytes[C]&128u)!=0u; }

#include <vm/rtc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static unsigned failures, calendars, alarms, invalid_dates;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"rtc: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void write_register(vm_rtc *r, pl_u64 ns, pl_u32 index, pl_u32 value)
{
    EXPECT(!vm_rtc_transfer(r,ns,0x70u,1u,&index));
    EXPECT(!vm_rtc_transfer(r,ns,0x71u,1u,&value));
}
static pl_u32 read_register(vm_rtc *r, pl_u64 ns, pl_u32 index)
{
    pl_u32 value=0u;
    EXPECT(!vm_rtc_transfer(r,ns,0x70u,1u,&index));
    EXPECT(!vm_rtc_transfer(r,ns,0x71u,0u,&value)); return value;
}
static void open_rtc(vm_rtc *r, pl_u64 seconds)
{ vm_rtc_reset(r); EXPECT(!vm_rtc_seed(r,seconds)); }
static unsigned encoded(unsigned value, unsigned mode)
{ return mode&4u ? value : value/10u*16u+value%10u; }
static void compare_calendar(pl_u64 seconds, unsigned mode)
{
    vm_rtc r; open_rtc(&r,seconds);
    write_register(&r,0u,11u,mode);
    time_t input=(time_t)seconds; const struct tm *converted=gmtime(&input);
    if (!converted) {
        fprintf(stderr,"rtc: libc calendar cannot represent %llu seconds\n",(unsigned long long)seconds);
        ++failures; return;
    }
    struct tm expected=*converted;
    unsigned year=(unsigned)expected.tm_year+1900u;
    EXPECT(read_register(&r,0u,0u)==encoded((unsigned)expected.tm_sec,mode));
    EXPECT(read_register(&r,0u,2u)==encoded((unsigned)expected.tm_min,mode));
    unsigned h=(unsigned)expected.tm_hour;
    EXPECT(read_register(&r,0u,4u)==(mode&2u ? encoded(h,mode)
        : encoded(h%12u ? h%12u : 12u,mode)|(h>=12u ? 128u : 0u)));
    EXPECT(read_register(&r,0u,6u)==encoded((unsigned)expected.tm_wday+1u,mode));
    EXPECT(read_register(&r,0u,7u)==encoded((unsigned)expected.tm_mday,mode));
    EXPECT(read_register(&r,0u,8u)==encoded((unsigned)expected.tm_mon+1u,mode));
    EXPECT(read_register(&r,0u,9u)==encoded(year%100u,mode));
    EXPECT(read_register(&r,0u,0x32u)==encoded(year/100u,mode));
    EXPECT(read_register(&r,0u,0x37u)==encoded(year/100u,mode)); ++calendars;
    /* Inverse conversion must preserve the whole epoch, not merely a day
     * field: this also checks Gregorian century/leap validity on writes. */
    write_register(&r,0u,7u,encoded((unsigned)expected.tm_mday,mode));
    EXPECT(r.seconds==seconds);
    if (seconds<=VM_RTC_MAX_SECONDS-86400u) {
        time_t following=(time_t)(seconds+86400u); converted=gmtime(&following);
        if (!converted) {
            fprintf(stderr,"rtc: libc following calendar cannot represent %llu seconds\n",(unsigned long long)following);
            ++failures; return;
        }
        struct tm tomorrow=*converted;
        if (tomorrow.tm_mon!=expected.tm_mon) {
            pl_u32 value=encoded((unsigned)expected.tm_mday+1u,mode); vm_rtc before=r;
            EXPECT(vm_rtc_transfer(&r,0u,0x71u,1u,&value)==-1 && !memcmp(&r,&before,sizeof r));
            ++invalid_dates;
        }
    }
}
static int trace(void)
{
    vm_rtc r; open_rtc(&r,1791117296ull); /* 2026-10-04T12:34:56Z */
    char op; unsigned coordinate,value; unsigned long long ns; pl_u64 now=0u;
    while (scanf(" %c",&op)==1) {
        if (op=='T') {
            if (scanf("%llu",&ns)!=1 || vm_rtc_advance(&r,(pl_u64)ns)) return 2;
            now=(pl_u64)ns;
        } else if (op=='W') {
            if (scanf("%u %u",&coordinate,&value)!=2
                    || vm_rtc_transfer(&r,now,coordinate,1u,&value)) return 2;
        } else if (op=='R') {
            value=0u;
            if (scanf("%u",&coordinate)!=1 || vm_rtc_transfer(&r,now,coordinate,0u,&value)) return 2;
            printf("%u\n",value);
        } else return 2;
    }
    return failures ? 1 : 0;
}
int main(int argc, char **argv)
{
    if (argc==2 && !strcmp(argv[1],"--trace")) return trace();
    /* Independent libc calendar, every day in a Gregorian 400-year era,
     * all four wire encodings. No libc is linked into the product device. */
    for (pl_u64 day=0u;day<146097u;++day)
        compare_calendar(day*86400u+(day*7919u)%86400u,(unsigned)(day&3u)*2u);
    for (unsigned mode=0u;mode<8u;mode+=2u) {
        compare_calendar(VM_RTC_MAX_SECONDS,mode); compare_calendar(4107542399ull,mode);
        compare_calendar(951782399ull,mode); compare_calendar(951782400ull,mode);
    }
    vm_rtc r; open_rtc(&r,59u);
    write_register(&r,1000000000u,0u,0x10u); /* minute rolled before the substitution */
    EXPECT(r.seconds==70u && read_register(&r,1000000000u,2u)==1u);
    open_rtc(&r,86399u); write_register(&r,0u,6u,2u);
    EXPECT(read_register(&r,1000000000u,6u)==3u); /* weekday is independently writable */
    open_rtc(&r,0u);
    EXPECT(!(read_register(&r,999755858u,10u)&128u));
    EXPECT(read_register(&r,999755859u,10u)&128u);
    EXPECT(!(read_register(&r,1000000000u,10u)&128u));
    EXPECT(read_register(&r,1000000000u,12u)==0x50u);
    EXPECT(!read_register(&r,1000000000u,12u));
    write_register(&r,1000000000u,11u,0x42u);
    EXPECT(read_register(&r,1001000000u,12u)==0xc0u);
    EXPECT(!vm_rtc_irq(&r) && !read_register(&r,1001000000u,12u));
    write_register(&r,1001000000u,11u,0x92u); /* SET clears UIE, inhibits calendar/UF/AF */
    EXPECT(read_register(&r,1001000000u,11u)==0x82u);
    EXPECT(read_register(&r,2000000000u,0u)==1u);
    EXPECT(read_register(&r,2000000000u,12u)==0x40u);
    write_register(&r,2000000000u,0u,0x15u); write_register(&r,2000000000u,11u,2u);
    EXPECT(r.seconds==15u && read_register(&r,2000000000u,0u)==0x15u);
    for (pl_u32 code=0u;code<16u;++code) {
        open_rtc(&r,0u); write_register(&r,0u,10u,0x20u|code);
        pl_u32 effective=code<=2u ? code+7u : code;
        pl_u64 threshold=(((1ull<<(effective-1u))*1000000000u)+32767u)/32768u;
        EXPECT(!(read_register(&r,threshold-1u,12u)&64u));
        EXPECT(!!(read_register(&r,threshold,12u)&64u)==!!code);
        EXPECT(!read_register(&r,threshold,12u));
    }
    open_rtc(&r,0u); write_register(&r,123456789u,10u,0x66u);
    read_register(&r,123456789u,12u);
    EXPECT(!read_register(&r,2123456789u,12u) && !r.seconds);
    write_register(&r,2123456789u,10u,0x26u);
    EXPECT(read_register(&r,2623456788u,0u)==0u);
    EXPECT(read_register(&r,2623456789u,0u)==1u); /* 500 ms after divider restart */
    /* Brute-force alarm specification vs the bounded product-of-digits next
     * match, including all wildcard combinations and wrap over midnight. */
    unsigned random=0x81818u;
    for (unsigned trial=0u;trial<120u;++trial) for (unsigned wild=0u;wild<8u;++wild) {
        random=random*1664525u+1013904223u; unsigned start=random%86400u;
        random=random*1664525u+1013904223u; unsigned h=random%24u;
        random=random*1664525u+1013904223u; unsigned m=random%60u;
        random=random*1664525u+1013904223u; unsigned s=random%60u;
        unsigned distance=1u;
        for (;distance<=86400u;++distance) {
            unsigned candidate=(start+distance)%86400u;
            if ((wild&4u || candidate/3600u==h) && (wild&2u || candidate/60u%60u==m)
                    && (wild&1u || candidate%60u==s)) break;
        }
        open_rtc(&r,start); write_register(&r,0u,11u,0x26u);
        write_register(&r,0u,5u,wild&4u ? 0xc0u : h);
        write_register(&r,0u,3u,wild&2u ? 0xc0u : m);
        write_register(&r,0u,1u,wild&1u ? 0xc0u : s);
        EXPECT(!(read_register(&r,(pl_u64)(distance-1u)*1000000000u,12u)&32u));
        EXPECT((read_register(&r,(pl_u64)distance*1000000000u,12u)&0xa0u)==0xa0u);
        EXPECT(!read_register(&r,(pl_u64)distance*1000000000u,12u)); ++alarms;
    }
    open_rtc(&r,0u); pl_u32 value=1u; vm_rtc before=r;
    EXPECT(vm_rtc_seed(&r,1u)==-1 && !memcmp(&r,&before,sizeof r));
    write_register(&r,0u,0x20u,0xabu); EXPECT(read_register(&r,0u,0x20u)==0xabu);
    EXPECT(read_register(&r,0u,13u)==128u);
    write_register(&r,0u,13u,0u); EXPECT(read_register(&r,0u,13u)==128u);
    pl_u32 index=11u; EXPECT(!vm_rtc_transfer(&r,0u,0x70u,1u,&index)); before=r;
    EXPECT(vm_rtc_transfer(&r,0u,0x71u,1u,&value)==-1 && !memcmp(&r,&before,sizeof r));
    index=7u; value=0x32u; EXPECT(!vm_rtc_transfer(&r,0u,0x70u,1u,&index)); before=r;
    EXPECT(vm_rtc_transfer(&r,1000000000u,0x71u,1u,&value)==-1 && !memcmp(&r,&before,sizeof r));
    index=1u; value=0x60u; EXPECT(!vm_rtc_transfer(&r,0u,0x70u,1u,&index)); before=r;
    EXPECT(vm_rtc_transfer(&r,0u,0x71u,1u,&value)==-1 && !memcmp(&r,&before,sizeof r));
    open_rtc(&r,VM_RTC_MAX_SECONDS); before=r;
    EXPECT(vm_rtc_advance(&r,1000000000u)==-1 && !memcmp(&r,&before,sizeof r));
    open_rtc(&r,0u); EXPECT(!vm_rtc_advance(&r,1u)); before=r;
    EXPECT(vm_rtc_advance(&r,0u)==-1 && !memcmp(&r,&before,sizeof r));
    open_rtc(&r,0u); before=r; EXPECT(!vm_rtc_advance(&r,~0ull));
    EXPECT(r.seconds==18446744073ull && r.fraction==709551615u);
    const pl_u8 calendar_indices[]={0u,2u,4u,6u,7u,8u,9u,0x32u};
    for (unsigned i=0u;i<sizeof calendar_indices;++i)
        EXPECT(r.bytes[calendar_indices[i]]==before.bytes[calendar_indices[i]]);
    /* Hundreds of years of elapsed events do not materialize a calendar or
     * scan missed ticks. SET alone freezes the currently observed calendar. */
    pl_u32 day=read_register(&r,~0ull,7u); write_register(&r,~0ull,11u,0x82u);
    EXPECT(r.bytes[7]==day && read_register(&r,~0ull,7u)==day);
    vm_rtc_reset(&r); value=0u; before=r;
    EXPECT(vm_rtc_transfer(&r,0u,0x71u,0u,&value)==-1 && !memcmp(&r,&before,sizeof r));
    if (!failures) printf("C RTC: %u independent libc calendars/inverses, %u invalid dates, %u brute alarm matches; SET/UIP/period/read-clear/refusal checks green (not Linux boot)\n",calendars,invalid_dates,alarms);
    return failures ? 1 : 0;
}

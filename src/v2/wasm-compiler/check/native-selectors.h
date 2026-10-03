/* Test-only visible selectors of the native oracle process. No product code
 * may use these values: compiled programs read their own machine_state. */
#ifndef NATIVE_SELECTORS_H
#define NATIVE_SELECTORS_H
static void native_selectors(pl_u64 values[6])
{
    pl_u16 value;
    __asm__ volatile("mov %%es,%0" : "=r"(value)); values[0]=value;
    __asm__ volatile("mov %%cs,%0" : "=r"(value)); values[1]=value;
    __asm__ volatile("mov %%ss,%0" : "=r"(value)); values[2]=value;
    __asm__ volatile("mov %%ds,%0" : "=r"(value)); values[3]=value;
    __asm__ volatile("mov %%fs,%0" : "=r"(value)); values[4]=value;
    __asm__ volatile("mov %%gs,%0" : "=r"(value)); values[5]=value;
}
#endif

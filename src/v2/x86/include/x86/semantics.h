#ifndef X86_SEMANTICS_H
#define X86_SEMANTICS_H

#include <x86/profile.h>

/* The immutable profile is the delivery machine contract.  Linked x86 is a
 * wider source language: a native optimized ELF retains an out-of-profile
 * instruction as an exact extension cut, while a delivery backend must either
 * lower that cut or prove that its fixed CPUID makes it unreachable. */

#endif /* X86_SEMANTICS_H */

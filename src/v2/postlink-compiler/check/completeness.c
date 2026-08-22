/* Fast closure witnesses for the linked-x86 frontend.
 *
 * This is intentionally a red/green publication gate, not a decoder smoke
 * test.  Every row is required by the x86-64 Linux boot/runtime contract and
 * must lower to a direct semantic plan.  A valid decode, an anonymous machine
 * barrier, or an interpreter fallback is not success.
 */

#include <stdio.h>

#include <postlink/semantic.h>

typedef struct {
    const char *domain;
    const char *name;
    const pl_u8 *bytes;
    pl_u32 byte_count;
} closure_case;

#define CASE(domain, name, bytes) \
    { domain, name, bytes, (pl_u32)sizeof bytes }

static const pl_u8 div_rbx[]       = { 0x48u, 0xf7u, 0xf3u };
static const pl_u8 rcl_rax[]       = { 0x48u, 0xd1u, 0xd0u };
static const pl_u8 rcr_rax_cl[]    = { 0x48u, 0xd3u, 0xd8u };
static const pl_u8 pxor_xmm0[]     = { 0x66u, 0x0fu, 0xefu, 0xc0u };
static const pl_u8 movdqa_xmm[]    = { 0x66u, 0x0fu, 0x6fu, 0xc1u };
static const pl_u8 movdqa_load[]   = { 0x66u, 0x0fu, 0x6fu, 0x00u };
static const pl_u8 movdqu_store[]  = { 0xf3u, 0x0fu, 0x7fu, 0x00u };
static const pl_u8 andps_load[]    = { 0x0fu, 0x54u, 0x00u };
static const pl_u8 andnps_xmm[]    = { 0x0fu, 0x55u, 0xc1u };
static const pl_u8 andnps_load[]   = { 0x0fu, 0x55u, 0x00u };
static const pl_u8 cmpxchg16b[]    = { 0x48u, 0x0fu, 0xc7u, 0x08u };
static const pl_u8 lock_xadd[]     = { 0xf0u, 0x0fu, 0xc1u, 0x18u };
static const pl_u8 lock_add[]      = { 0xf0u, 0x01u, 0x00u };
static const pl_u8 lock_add_imm8[] = { 0xf0u, 0x80u, 0x00u, 0x0fu };
static const pl_u8 lock_and_imm32[] = {
    0xf0u, 0x81u, 0x20u, 0x78u, 0x56u, 0x34u, 0x12u,
};
static const pl_u8 lock_sub_imm8_64[] = {
    0xf0u, 0x48u, 0x83u, 0x28u, 0xffu,
};
static const pl_u8 lock_inc[]      = { 0xf0u, 0xffu, 0x00u };
static const pl_u8 lock_dec[]      = { 0xf0u, 0xffu, 0x08u };
static const pl_u8 lock_bts[]      = { 0xf0u, 0x48u, 0x0fu, 0xabu, 0x02u };
static const pl_u8 lock_btr[]      = { 0xf0u, 0x48u, 0x0fu, 0xb3u, 0x0au };
static const pl_u8 lock_btc[]      = { 0xf0u, 0x48u, 0x0fu, 0xbbu, 0x12u };
static const pl_u8 movsq[]         = { 0x48u, 0xa5u };
static const pl_u8 rep_movsq[]     = { 0xf3u, 0x48u, 0xa5u };
static const pl_u8 rep_movsd[]     = { 0xf3u, 0xa5u };
static const pl_u8 rep_movsb[]     = { 0xf3u, 0xa4u };
static const pl_u8 rep_stosd[]     = { 0xf3u, 0xabu };
static const pl_u8 repe_cmpsd[]    = { 0xf3u, 0xa7u };
static const pl_u8 repe_scasb[]    = { 0xf3u, 0xaeu };
static const pl_u8 repne_scasd[]   = { 0xf2u, 0xafu };
static const pl_u8 repne_lodsb[]   = { 0xf2u, 0xacu };

static const pl_u8 cli[]           = { 0xfau };
static const pl_u8 sti[]           = { 0xfbu };
static const pl_u8 hlt[]           = { 0xf4u };
static const pl_u8 wrmsr[]         = { 0x0fu, 0x30u };
static const pl_u8 rdmsr[]         = { 0x0fu, 0x32u };
static const pl_u8 cpuid[]         = { 0x0fu, 0xa2u };
static const pl_u8 rdtsc[]         = { 0x0fu, 0x31u };
static const pl_u8 in_al_dx[]      = { 0xecu };
static const pl_u8 out_dx_al[]     = { 0xeeu };
static const pl_u8 mov_cr3_rax[]   = { 0x0fu, 0x22u, 0xd8u };
static const pl_u8 mov_rax_cr4[]   = { 0x0fu, 0x20u, 0xe0u };
static const pl_u8 mov_ds_ax[]     = { 0x8eu, 0xd8u };
static const pl_u8 mov_ds_rax[]    = { 0x8eu, 0x18u };
static const pl_u8 mov_ecx_fs[]    = { 0x8cu, 0xe9u };
static const pl_u8 lfs_eax[]       = { 0x0fu, 0xb4u, 0x00u };
static const pl_u8 lgs_eax[]       = { 0x0fu, 0xb5u, 0x00u };
static const pl_u8 lss_eax[]       = { 0x0fu, 0xb2u, 0x00u };
static const pl_u8 lfs_rax[]       = { 0x48u, 0x0fu, 0xb4u, 0x00u };
static const pl_u8 lgs_rax[]       = { 0x48u, 0x0fu, 0xb5u, 0x00u };
static const pl_u8 lss_rax[]       = { 0x48u, 0x0fu, 0xb2u, 0x00u };
static const pl_u8 lgdt_rax[]      = { 0x0fu, 0x01u, 0x10u };
static const pl_u8 lidt_rax[]      = { 0x0fu, 0x01u, 0x18u };
static const pl_u8 sgdt_rax[]      = { 0x0fu, 0x01u, 0x00u };
static const pl_u8 sidt_rax[]      = { 0x0fu, 0x01u, 0x08u };
static const pl_u8 invlpg_rax[]    = { 0x0fu, 0x01u, 0x38u };
static const pl_u8 lretq[]         = { 0x48u, 0xcbu };
static const pl_u8 iretw[]         = { 0x66u, 0xcfu };
static const pl_u8 iretd[]         = { 0xcfu };
static const pl_u8 iretq[]         = { 0x48u, 0xcfu };
static const pl_u8 syscall[]       = { 0x0fu, 0x05u };
static const pl_u8 sysret[]        = { 0x48u, 0x0fu, 0x07u };
static const pl_u8 sysenter[]      = { 0x0fu, 0x34u };
static const pl_u8 sysexit[]       = { 0x0fu, 0x35u };
static const pl_u8 sysexit64[]     = { 0x48u, 0x0fu, 0x35u };
static const pl_u8 swapgs[]        = { 0x0fu, 0x01u, 0xf8u };
static const pl_u8 int_80[]         = { 0xcdu, 0x80u };
static const pl_u8 sldt_rax[]       = { 0x0fu, 0x00u, 0xc0u };
static const pl_u8 str_rax[]        = { 0x0fu, 0x00u, 0xc8u };
static const pl_u8 sldt_mem[]       = { 0x0fu, 0x00u, 0x00u };
static const pl_u8 str_mem[]        = { 0x0fu, 0x00u, 0x08u };
static const pl_u8 verw_ax[]        = { 0x0fu, 0x00u, 0xe8u };
static const pl_u8 verw_mem[]       = { 0x0fu, 0x00u, 0x28u };
static const pl_u8 far_call_mem[]   = { 0xffu, 0x18u };
static const pl_u8 far_call_mem16[] = { 0x66u, 0xffu, 0x18u };
static const pl_u8 far_jump_mem[]   = { 0xffu, 0x28u };
static const pl_u8 pop_rsp_mem[]    = { 0x8fu, 0x04u, 0x24u };
static const pl_u8 fwait[]          = { 0x9bu };
static const pl_u8 ftst[]           = { 0xd9u, 0xe4u };
static const pl_u8 fxam[]           = { 0xd9u, 0xe5u };
static const pl_u8 fxtract[]        = { 0xd9u, 0xf4u };
static const pl_u8 f2xm1[]          = { 0xd9u, 0xf0u };
static const pl_u8 fyl2x[]          = { 0xd9u, 0xf1u };
static const pl_u8 fpatan[]         = { 0xd9u, 0xf3u };
static const pl_u8 fyl2xp1[]        = { 0xd9u, 0xf9u };
static const pl_u8 fcompp[]         = { 0xdeu, 0xd9u };
static const pl_u8 fsqrt[]          = { 0xd9u, 0xfau };
static const pl_u8 cvttps2pi[]      = { 0x0fu, 0x2cu, 0xc3u };
static const pl_u8 cvtps2pi[]       = { 0x0fu, 0x2du, 0xc3u };
static const pl_u8 cvtps2pi_mem[]   = { 0x0fu, 0x2du, 0x18u };
static const pl_u8 cvtpi2ps_reg[]   = { 0x0fu, 0x2au, 0xfcu };
static const pl_u8 cvtpi2ps_mem[]   = { 0x0fu, 0x2au, 0x38u };
static const pl_u8 cvtps2pd_reg[]   = { 0x0fu, 0x5au, 0xc1u };
static const pl_u8 cvtps2pd_mem[]   = { 0x0fu, 0x5au, 0x00u };
static const pl_u8 cvttpd2pi_reg[]  = { 0x66u, 0x0fu, 0x2cu, 0xd9u };
static const pl_u8 cvttpd2pi_mem[]  = { 0x66u, 0x0fu, 0x2cu, 0x18u };
static const pl_u8 maskmovq[]       = { 0x0fu, 0xf7u, 0xc1u };
static const pl_u8 sqrtps[]         = { 0x0fu, 0x51u, 0xc3u };
static const pl_u8 rcpps_reg[]      = { 0x0fu, 0x53u, 0xc1u };
static const pl_u8 rcpps_mem[]      = { 0x0fu, 0x53u, 0x00u };
static const pl_u8 rsqrtps_reg[]    = { 0x0fu, 0x52u, 0xc1u };
static const pl_u8 rsqrtps_mem[]    = { 0x0fu, 0x52u, 0x00u };
static const pl_u8 mulps_reg[]      = { 0x0fu, 0x59u, 0xc1u };
static const pl_u8 mulps_mem[]      = { 0x0fu, 0x59u, 0x00u };
static const pl_u8 subps_reg[]      = { 0x0fu, 0x5cu, 0xc1u };
static const pl_u8 subps_mem[]      = { 0x0fu, 0x5cu, 0x00u };
static const pl_u8 divps_reg[]      = { 0x0fu, 0x5eu, 0xc1u };
static const pl_u8 divps_mem[]      = { 0x0fu, 0x5eu, 0x00u };
static const pl_u8 fprem[]          = { 0xd9u, 0xf8u };
static const pl_u8 fprem1[]         = { 0xd9u, 0xf5u };
static const pl_u8 fchs[]           = { 0xd9u, 0xe0u };
static const pl_u8 fabs_x87[]       = { 0xd9u, 0xe1u };
static const pl_u8 cmpps[]          = { 0x0fu, 0xc2u, 0xc3u, 0x00u };
static const pl_u8 cmpps_mem[]      = { 0x0fu, 0xc2u, 0x18u, 0x00u };
static const pl_u8 cmpps_mem_high[] = { 0x0fu, 0xc2u, 0x08u, 0xc1u };
static const pl_u8 addps[]          = { 0x0fu, 0x58u, 0xc3u };
static const pl_u8 addps_mem[]      = { 0x0fu, 0x58u, 0x18u };
static const pl_u8 maxps_mem[]      = { 0x0fu, 0x5fu, 0x00u };
static const pl_u8 minps_mem[]      = { 0x0fu, 0x5du, 0x00u };
static const pl_u8 ucomiss[]         = { 0x0fu, 0x2eu, 0xc1u };
static const pl_u8 ucomiss_mem[]     = { 0x0fu, 0x2eu, 0x00u };
static const pl_u8 comiss[]          = { 0x0fu, 0x2fu, 0xc1u };
static const pl_u8 rdrand_rdx[]      = { 0x48u, 0x0fu, 0xc7u, 0xf2u };
static const pl_u8 rdseed_rax[]      = { 0x48u, 0x0fu, 0xc7u, 0xf8u };
static const pl_u8 fild_i64[]       = { 0xdfu, 0x28u };
static const pl_u8 fisttp_i32[]     = { 0xdbu, 0x08u };
static const pl_u8 fistp_i64[]      = { 0xdfu, 0x38u };
static const pl_u8 fist_i32[]       = { 0xdbu, 0x10u };
static const pl_u8 fbld_bcd[]       = { 0xdfu, 0x20u };
static const pl_u8 fbstp_bcd[]      = { 0xdfu, 0x30u };
static const pl_u8 fnstcw_mem[]     = { 0xd9u, 0x38u };
static const pl_u8 fldcw_mem[]      = { 0xd9u, 0x28u };
static const pl_u8 fnstsw_mem[]     = { 0xddu, 0x38u };
static const pl_u8 fnstsw_ax[]      = { 0xdfu, 0xe0u };
static const pl_u8 fnstenv_mem[]    = { 0xd9u, 0x30u };
static const pl_u8 fldenv_mem[]     = { 0xd9u, 0x20u };
static const pl_u8 fnsave_mem[]     = { 0xddu, 0x30u };
static const pl_u8 frstor_mem[]     = { 0xddu, 0x20u };
static const pl_u8 fcmovnb_st1[]    = { 0xdbu, 0xc1u };
static const pl_u8 fucomip_st1[]    = { 0xdfu, 0xe9u };
static const pl_u8 fucomi_st1[]     = { 0xdbu, 0xe9u };
static const pl_u8 fcomip_st1[]     = { 0xdfu, 0xf1u };
static const pl_u8 fcomi_st1[]      = { 0xdbu, 0xf1u };
static const pl_u8 fimul_i32[]      = { 0xdau, 0x08u };
static const pl_u8 fadd_f64[]       = { 0xdcu, 0x00u };
static const pl_u8 fadd_st1[]       = { 0xd8u, 0xc1u };
static const pl_u8 faddp_st1[]      = { 0xdeu, 0xc1u };
static const pl_u8 fmul_f64[]       = { 0xdcu, 0x08u };
static const pl_u8 fmul_st1[]       = { 0xd8u, 0xc9u };
static const pl_u8 fmulp_st1[]      = { 0xdeu, 0xc9u };
static const pl_u8 fld_f32[]        = { 0xd9u, 0x00u };
static const pl_u8 fld_st1[]        = { 0xd9u, 0xc1u };
static const pl_u8 fxch_st1[]       = { 0xd9u, 0xc9u };
static const pl_u8 ffree_st1[]      = { 0xddu, 0xc1u };
static const pl_u8 ffreep_st1[]     = { 0xdfu, 0xc1u };
static const pl_u8 fcomp_f32[]      = { 0xd8u, 0x18u };
static const pl_u8 fcom_f32[]       = { 0xd8u, 0x10u };
static const pl_u8 ficomp_i16[]     = { 0xdeu, 0x18u };
static const pl_u8 ficom_i32[]      = { 0xdau, 0x10u };
static const pl_u8 fiadd_i32[]      = { 0xdau, 0x00u };
static const pl_u8 fisub_i16[]      = { 0xdeu, 0x20u };
static const pl_u8 fisubr_i16[]     = { 0xdeu, 0x28u };
static const pl_u8 fsub_f32[]       = { 0xd8u, 0x20u };
static const pl_u8 fsubr_f64[]      = { 0xdcu, 0x28u };
static const pl_u8 fsubp_st1[]      = { 0xdeu, 0xe9u };
static const pl_u8 fsubrp_st1[]     = { 0xdeu, 0xe1u };
static const pl_u8 fst_f32[]        = { 0xd9u, 0x10u };
static const pl_u8 fstp_f64[]       = { 0xddu, 0x18u };
static const pl_u8 fst_st1[]        = { 0xddu, 0xd1u };
static const pl_u8 fstp_st1[]       = { 0xdfu, 0xd1u };
static const pl_u8 fdiv_f32[]       = { 0xd8u, 0x30u };
static const pl_u8 fdivr_f64[]      = { 0xdcu, 0x38u };
static const pl_u8 fdivp_st1[]      = { 0xdeu, 0xf9u };
static const pl_u8 fdivrp_st1[]     = { 0xdeu, 0xf1u };
static const pl_u8 fidiv_i32[]      = { 0xdau, 0x30u };
static const pl_u8 fidivr_i16[]     = { 0xdeu, 0x38u };
static const pl_u8 movq_mmx_load[]  = { 0x0fu, 0x6fu, 0x00u };
static const pl_u8 movq_mmx_store[] = { 0x0fu, 0x7fu, 0x00u };
static const pl_u8 paddd_mmx[]      = { 0x0fu, 0xfeu, 0xc1u };
static const pl_u8 paddd_xmm[]      = { 0x66u, 0x0fu, 0xfeu, 0xc1u };
static const pl_u8 psrld_xmm_imm[]  = {
    0x66u, 0x0fu, 0x72u, 0xd1u, 0x0cu,
};
static const pl_u8 pslld_xmm_imm[]  = {
    0x66u, 0x0fu, 0x72u, 0xf0u, 0x14u,
};
static const pl_u8 pxor_mmx[]       = { 0x0fu, 0xefu, 0xc1u };
static const pl_u8 pcmpeqb_mmx[]    = { 0x0fu, 0x74u, 0x00u };
static const pl_u8 pcmpgtd_mmx[]    = { 0x0fu, 0x66u, 0xc1u };
static const pl_u8 psrld_mmx[]      = { 0x0fu, 0xd2u, 0x00u };
static const pl_u8 pslld_mmx[]      = { 0x0fu, 0xf2u, 0xc1u };
static const pl_u8 psrld_mmx_imm[]  = { 0x0fu, 0x72u, 0xd1u, 0x0cu };
static const pl_u8 pslld_mmx_imm[]  = { 0x0fu, 0x72u, 0xf0u, 0x14u };
static const pl_u8 psubd_mmx[]      = { 0x0fu, 0xfau, 0x00u };
static const pl_u8 pcmpeqw_mmx[]    = { 0x0fu, 0x75u, 0x00u };
static const pl_u8 pcmpeqd_mmx[]    = { 0x0fu, 0x76u, 0x00u };
static const pl_u8 pmullw_mmx[]     = { 0x0fu, 0xd5u, 0x00u };
static const pl_u8 pmullw_xmm[]     = { 0x66u, 0x0fu, 0xd5u, 0xebu };
static const pl_u8 pcmpeqb_xmm[]    = { 0x66u, 0x0fu, 0x74u, 0xfcu };
static const pl_u8 pshufhw_xmm[]    = {
    0xf3u, 0x0fu, 0x70u, 0xd0u, 0x50u,
};
static const pl_u8 psubsw_mmx[]     = { 0x0fu, 0xe9u, 0x00u };
static const pl_u8 psubsb_mmx[]     = { 0x0fu, 0xe8u, 0x00u };
static const pl_u8 paddb_mmx[]      = { 0x0fu, 0xfcu, 0x00u };
static const pl_u8 paddd_xmm_mem[]  = { 0x66u, 0x0fu, 0xfeu, 0x00u };
static const pl_u8 pshufd_xmm[]     = {
    0x66u, 0x0fu, 0x70u, 0xc1u, 0x1bu,
};
static const pl_u8 pshufd_xmm_mem[] = {
    0x66u, 0x0fu, 0x70u, 0x00u, 0x1bu,
};
static const pl_u8 pshufw_mmx[]     = { 0x0fu, 0x70u, 0xc1u, 0x1bu };
static const pl_u8 pshufw_mmx_mem[] = { 0x0fu, 0x70u, 0x00u, 0x1bu };
static const pl_u8 shufps_xmm[]     = { 0x0fu, 0xc6u, 0xc1u, 0x1bu };
static const pl_u8 shufps_xmm_mem[] = { 0x0fu, 0xc6u, 0x00u, 0x1bu };
static const pl_u8 psrlq_mmx[]      = { 0x0fu, 0xd3u, 0xc1u };
static const pl_u8 psrlq_mmx_mem[]  = { 0x0fu, 0xd3u, 0x00u };
static const pl_u8 psllq_mmx[]      = { 0x0fu, 0xf3u, 0xc1u };
static const pl_u8 psrlq_mmx_imm[]  = { 0x0fu, 0x73u, 0xd0u, 0x0cu };
static const pl_u8 psllq_mmx_imm[]  = { 0x0fu, 0x73u, 0xf0u, 0x14u };
static const pl_u8 movd_mmx_load[]  = { 0x0fu, 0x6eu, 0x00u };
static const pl_u8 movd_mmx_store[] = { 0x0fu, 0x7eu, 0x00u };
static const pl_u8 emms[]           = { 0x0fu, 0x77u };
static const pl_u8 femms[]          = { 0x0fu, 0x0eu };
static const pl_u8 paddw_mmx[]      = { 0x0fu, 0xfdu, 0xc1u };
static const pl_u8 psubq_mmx[]      = { 0x0fu, 0xfbu, 0xc1u };
static const pl_u8 lfence[]         = { 0x0fu, 0xaeu, 0xe8u };
static const pl_u8 mfence[]         = { 0x0fu, 0xaeu, 0xf0u };
static const pl_u8 sfence[]         = { 0x0fu, 0xaeu, 0xf8u };
static const pl_u8 serialize[]      = { 0x0fu, 0x01u, 0xe8u };
static const pl_u8 wbinvd[]         = { 0x0fu, 0x09u };
static const pl_u8 invd[]           = { 0x0fu, 0x08u };
static const pl_u8 clflush_rax[]    = { 0x0fu, 0xaeu, 0x38u };
static const pl_u8 clwb_rax[]       = { 0x66u, 0x0fu, 0xaeu, 0x30u };
static const pl_u8 fucompp[]        = { 0xdau, 0xe9u };
static const pl_u8 fld1[]           = { 0xd9u, 0xe8u };
static const pl_u8 fldl2t[]         = { 0xd9u, 0xe9u };
static const pl_u8 fldl2e[]         = { 0xd9u, 0xeau };
static const pl_u8 fldpi[]          = { 0xd9u, 0xebu };
static const pl_u8 fldlg2[]         = { 0xd9u, 0xecu };
static const pl_u8 fldln2[]         = { 0xd9u, 0xedu };
static const pl_u8 fldz[]           = { 0xd9u, 0xeeu };
static const pl_u8 rdtscp[]         = { 0x0fu, 0x01u, 0xf9u };
static const pl_u8 movd_xmm_load[]  = { 0x66u, 0x0fu, 0x6eu, 0xc7u };
static const pl_u8 movd_xmm_store[] = { 0x66u, 0x0fu, 0x7eu, 0xc7u };
static const pl_u8 movd_xmm_mem[]   = { 0x66u, 0x0fu, 0x6eu, 0x00u };
static const pl_u8 mov_rbp_dr3[]    = { 0x0fu, 0x21u, 0xddu };
static const pl_u8 mov_dr3_rbp[]    = { 0x0fu, 0x23u, 0xddu };
static const pl_u8 lar_ecx_ecx[]    = { 0x0fu, 0x02u, 0xc9u };
static const pl_u8 lar_ecx_mem[]    = { 0x0fu, 0x02u, 0x08u };
static const pl_u8 lsl_eax_mem[]    = { 0x0fu, 0x03u, 0x00u };
static const pl_u8 lldt_mem[]       = { 0x0fu, 0x00u, 0x10u };
static const pl_u8 lldt_ax[]        = { 0x0fu, 0x00u, 0xd0u };
static const pl_u8 rdpmc[]          = { 0x0fu, 0x33u };
static const pl_u8 lmsw_mem[]       = { 0x0fu, 0x01u, 0x30u };
static const pl_u8 lmsw_ax[]        = { 0x0fu, 0x01u, 0xf0u };
static const pl_u8 clts[]           = { 0x0fu, 0x06u };
static const pl_u8 fincstp[]        = { 0xd9u, 0xf7u };
static const pl_u8 fdecstp[]        = { 0xd9u, 0xf6u };
static const pl_u8 ltr_mem[]        = { 0x0fu, 0x00u, 0x18u };
static const pl_u8 ltr_ax[]         = { 0x0fu, 0x00u, 0xd8u };
static const pl_u8 push_fs[]        = { 0x0fu, 0xa0u };
static const pl_u8 pop_fs[]         = { 0x0fu, 0xa1u };
static const pl_u8 push_gs[]        = { 0x0fu, 0xa8u };
static const pl_u8 pop_gs[]         = { 0x0fu, 0xa9u };
static const pl_u8 psadbw_mmx[]     = { 0x0fu, 0xf6u, 0xc1u };
static const pl_u8 unpcklps_xmm[]   = { 0x0fu, 0x14u, 0xc1u };
static const pl_u8 unpcklps_mem[]   = { 0x0fu, 0x14u, 0x00u };
static const pl_u8 punpckldq_xmm[]  = { 0x66u, 0x0fu, 0x62u, 0xc1u };
static const pl_u8 punpckldq_mem[]  = { 0x66u, 0x0fu, 0x62u, 0x00u };
static const pl_u8 punpckhqdq_xmm[] = { 0x66u, 0x0fu, 0x6du, 0xc1u };
static const pl_u8 punpckhqdq_mem[] = { 0x66u, 0x0fu, 0x6du, 0x00u };
static const pl_u8 psubb_mmx[]      = { 0x0fu, 0xf8u, 0xc1u };
static const pl_u8 pcmpgtw_mmx[]    = { 0x0fu, 0x65u, 0xc1u };
static const pl_u8 pandn_mmx[]      = { 0x0fu, 0xdfu, 0xc1u };
static const pl_u8 punpckhbw_mmx[]  = { 0x0fu, 0x68u, 0xc1u };
static const pl_u8 punpckhbw_mem[]  = { 0x0fu, 0x68u, 0x00u };
static const pl_u8 punpckhbw_xmm_mem[] = { 0x66u, 0x0fu, 0x68u, 0x00u };
static const pl_u8 pmaddwd_mmx[]    = { 0x0fu, 0xf5u, 0xc1u };
static const pl_u8 paddq_mmx[]      = { 0x0fu, 0xd4u, 0xc1u };
static const pl_u8 pmulhuw_mmx[]    = { 0x0fu, 0xe4u, 0xc1u };
static const pl_u8 pminsw_mmx[]     = { 0x0fu, 0xeau, 0xc1u };
static const pl_u8 psrlq_xmm[]      = {
    0x66u, 0x0fu, 0x73u, 0xd2u, 0x11u,
};
static const pl_u8 movq_xmm_gpr[]   = { 0x66u, 0x48u, 0x0fu, 0x6eu, 0xcfu };
static const pl_u8 movq_gpr_xmm[]   = { 0x66u, 0x48u, 0x0fu, 0x7eu, 0xc8u };
static const pl_u8 cmpxchg8b_mem[]  = { 0x0fu, 0xc7u, 0x08u };
static const pl_u8 fninit[]         = { 0xdbu, 0xe3u };
static const pl_u8 punpckhwd_mmx[]  = { 0x0fu, 0x69u, 0xc1u };
static const pl_u8 psubw_mmx[]      = { 0x0fu, 0xf9u, 0xc1u };
static const pl_u8 punpcklqdq_xmm[] = { 0x66u, 0x0fu, 0x6cu, 0xc1u };
static const pl_u8 clflushopt_rax[] = { 0x66u, 0x0fu, 0xaeu, 0x38u };
static const pl_u8 movq_mmx_gpr[]   = { 0x48u, 0x0fu, 0x6eu, 0xcfu };
static const pl_u8 movlps_store[]   = { 0x0fu, 0x13u, 0x00u };
static const pl_u8 movhps_load[]    = { 0x0fu, 0x16u, 0x00u };
static const pl_u8 pinsrw_mmx[]     = { 0x0fu, 0xc4u, 0xc7u, 0x03u };
static const pl_u8 pextrw_mmx[]     = { 0x0fu, 0xc5u, 0xe3u, 0xffu };
static const pl_u8 pextrw_xmm[]     = { 0x66u, 0x0fu, 0xc5u, 0xe3u, 0x07u };
static const pl_u8 pslldq_xmm[]     = { 0x66u, 0x0fu, 0x73u, 0xf9u, 0x0cu };
static const pl_u8 psrldq_xmm[]     = { 0x66u, 0x0fu, 0x73u, 0xd8u, 0x08u };
static const pl_u8 pmuludq_mmx[]    = { 0x0fu, 0xf4u, 0xc1u };
static const pl_u8 pcmpgtb_mmx[]    = { 0x0fu, 0x64u, 0xc1u };
static const pl_u8 pmulhw_mmx[]     = { 0x0fu, 0xe5u, 0xc1u };
static const pl_u8 packuswb_mmx[]   = { 0x0fu, 0x67u, 0xc1u };
static const pl_u8 packuswb_xmm[]   = { 0x66u, 0x0fu, 0x67u, 0xc1u };
static const pl_u8 paddsw_mmx[]     = { 0x0fu, 0xedu, 0xc1u };
static const pl_u8 psllw_mmx[]      = { 0x0fu, 0xf1u, 0xc1u };
static const pl_u8 psllw_xmm[]      = { 0x66u, 0x0fu, 0xf1u, 0xc1u };
static const pl_u8 pmaxsw_mmx[]     = { 0x0fu, 0xeeu, 0xc1u };
static const pl_u8 psubusb_mmx[]    = { 0x0fu, 0xd8u, 0xc1u };
static const pl_u8 paddusb_mmx[]    = { 0x0fu, 0xdcu, 0xc1u };
static const pl_u8 pavgb_mmx[]      = { 0x0fu, 0xe0u, 0xc1u };
static const pl_u8 pavgw_mmx[]      = { 0x0fu, 0xe3u, 0xc1u };
static const pl_u8 pmaxub_mmx[]     = { 0x0fu, 0xdeu, 0xc1u };
static const pl_u8 psrad_mmx[]      = { 0x0fu, 0xe2u, 0xc1u };
static const pl_u8 paddusb_xmm[]    = { 0x66u, 0x0fu, 0xdcu, 0xc1u };
static const pl_u8 pavgb_xmm[]      = { 0x66u, 0x0fu, 0xe0u, 0xc1u };
static const pl_u8 pavgw_xmm[]      = { 0x66u, 0x0fu, 0xe3u, 0xc1u };
static const pl_u8 pmaxub_xmm[]     = { 0x66u, 0x0fu, 0xdeu, 0xc1u };
static const pl_u8 psrad_xmm[]      = { 0x66u, 0x0fu, 0xe2u, 0xc1u };
static const pl_u8 movntps_mem[]    = { 0x0fu, 0x2bu, 0x00u };
static const pl_u8 unpckhps_xmm[]  = { 0x0fu, 0x15u, 0xc1u };
static const pl_u8 punpckhdq_mmx[] = { 0x0fu, 0x6au, 0xc1u };
static const pl_u8 punpcklbw_mmx_mem[] = { 0x0fu, 0x60u, 0x00u };
static const pl_u8 packssdw_mmx[]  = { 0x0fu, 0x6bu, 0xc1u };
static const pl_u8 paddsb_mmx[]     = { 0x0fu, 0xecu, 0xc1u };
static const pl_u8 paddusw_mmx[]    = { 0x0fu, 0xddu, 0xc1u };
static const pl_u8 pminub_mmx[]     = { 0x0fu, 0xdau, 0xc1u };
static const pl_u8 psraw_mmx[]      = { 0x0fu, 0xe1u, 0xc1u };
static const pl_u8 psrlw_mmx[]      = { 0x0fu, 0xd1u, 0xc1u };
static const pl_u8 packsswb_mmx[]   = { 0x0fu, 0x63u, 0xc1u };
static const pl_u8 psubusw_mmx[]    = { 0x0fu, 0xd9u, 0xc1u };
static const pl_u8 punpckldq_mmx_mem[] = { 0x0fu, 0x62u, 0x00u };
static const pl_u8 punpcklwd_mmx_mem[] = { 0x0fu, 0x61u, 0x00u };
static const pl_u8 punpcklwd_xmm[] = { 0x66u, 0x0fu, 0x61u, 0xc1u };
static const pl_u8 fnclex[]         = { 0xdbu, 0xe2u };
static const pl_u8 invlpgb[]        = { 0x0fu, 0x01u, 0xfeu };
static const pl_u8 fcos[]           = { 0xd9u, 0xffu };
static const pl_u8 fsin[]           = { 0xd9u, 0xfeu };
static const pl_u8 fsincos[]        = { 0xd9u, 0xfbu };
static const pl_u8 fptan[]          = { 0xd9u, 0xf2u };
static const pl_u8 fstpnce[]        = { 0xd9u, 0xd8u };
static const pl_u8 frndint[]        = { 0xd9u, 0xfcu };
static const pl_u8 fscale[]         = { 0xd9u, 0xfdu };
static const pl_u8 fxsave[]         = { 0x0fu, 0xaeu, 0x00u };
static const pl_u8 fxsave64[]       = { 0x48u, 0x0fu, 0xaeu, 0x00u };
static const pl_u8 fxrstor[]        = { 0x0fu, 0xaeu, 0x08u };
static const pl_u8 fxrstor64[]      = { 0x48u, 0x0fu, 0xaeu, 0x08u };
static const pl_u8 cvtdq2ps[]       = { 0x0fu, 0x5bu, 0xc3u };
static const pl_u8 jknzd_knc[]      = {
    0xc5u, 0x48u, 0x85u, 0xc0u, 0x75u, 0x13u, 0x49u,
};
static const pl_u8 vpxor_avx[]      = { 0xc5u, 0xe9u, 0xefu, 0xfcu };
static const pl_u8 pshufb_ssse3[]   = {
    0x66u, 0x0fu, 0x38u, 0x00u, 0xcbu,
};
static const pl_u8 clac_smap[]      = { 0x0fu, 0x01u, 0xcau };
static const pl_u8 xbegin_rtm[]     = {
    0xc7u, 0xf8u, 0xfau, 0x8au, 0x81u, 0xe8u,
};
static const pl_u8 sha256rnds2[]    = {
    0x0fu, 0x38u, 0xcbu, 0xd1u,
};
static const pl_u8 pclmulqdq[]      = {
    0x66u, 0x0fu, 0x3au, 0x44u, 0xc1u, 0x00u,
};
static const pl_u8 getsec_smx[]     = { 0x0fu, 0x37u };
static const pl_u8 mwait_monitor[]  = { 0x0fu, 0x01u, 0xc9u };
static const pl_u8 vmread_vtx[]     = { 0x0fu, 0x78u, 0xc0u };
static const pl_u8 bndldx_mpx[]     = { 0x0fu, 0x1au, 0x00u };
static const pl_u8 xrstor_xsave[]   = { 0x0fu, 0xaeu, 0x28u };
static const pl_u8 xsaveopt[]       = { 0x0fu, 0xaeu, 0x30u };
static const pl_u8 rsm_no_smm[]     = { 0x0fu, 0xaau };
static const pl_u8 pextrd_sse4[]    = {
    0x66u, 0x0fu, 0x3au, 0x16u, 0xc0u, 0x02u,
};
static const pl_u8 invpcid_no_feature[] = {
    0x66u, 0x0fu, 0x38u, 0x82u, 0x04u, 0x24u,
};
static const pl_u8 cldemote_no_feature[] = { 0x0fu, 0x1cu, 0x00u };
static const pl_u8 pavgusb_3dnow[]  = {
    0x0fu, 0x0fu, 0xc1u, 0xbfu,
};
static const pl_u8 pbndkb_no_feature[] = { 0x0fu, 0x01u, 0xc7u };
static const pl_u8 rdpid_no_feature[] = { 0xf3u, 0x0fu, 0xc7u, 0xf8u };
static const pl_u8 tilerelease_no_feature[] = {
    0xc4u, 0xe2u, 0x78u, 0x49u, 0xc0u,
};
static const pl_u8 tpause_no_feature[] = { 0x66u, 0x0fu, 0xaeu, 0xf1u };
static const pl_u8 xsha256_padlock[] = { 0xf3u, 0x0fu, 0xa6u, 0xd0u };
static const pl_u8 unpcklpd_xmm[] = { 0x66u, 0x0fu, 0x14u, 0xecu };
static const pl_u8 pmovmskb_mmx[] = { 0x0fu, 0xd7u, 0xffu };
static const pl_u8 movhlps_xmm[] = { 0x0fu, 0x12u, 0xf5u };
static const pl_u8 ldmxcsr_mem[] = { 0x0fu, 0xaeu, 0x54u, 0x24u, 0x0cu };
static const pl_u8 stmxcsr_mem[] = {
    0x0fu, 0xaeu, 0x9eu, 0xffu, 0x03u, 0x00u, 0x00u,
};
static const pl_u8 movntq_mem[] = { 0x0fu, 0xe7u, 0x00u };

static const closure_case cases[] = {
    CASE("ISA", "DIV r/m64 with precise #DE", div_rbx),
    CASE("ISA", "RCL r64,1", rcl_rax),
    CASE("ISA", "RCR r64,CL", rcr_rax_cl),
    CASE("ISA", "PXOR xmm,xmm", pxor_xmm0),
    CASE("ISA", "MOVDQA xmm,xmm", movdqa_xmm),
    CASE("ISA", "MOVDQA xmm,m128", movdqa_load),
    CASE("ISA", "MOVDQU m128,xmm", movdqu_store),
    CASE("ISA", "ANDPS xmm,m128", andps_load),
    CASE("machine ABI", "ANDNPS XMM0,XMM1", andnps_xmm),
    CASE("machine ABI", "ANDNPS XMM0,[RAX]", andnps_load),
    CASE("ISA", "CMPXCHG16B m128", cmpxchg16b),
    CASE("ISA", "LOCK XADD m32,r32", lock_xadd),
    CASE("ISA", "LOCK ADD m32,r32", lock_add),
    CASE("ISA", "LOCK ADD m8,imm8", lock_add_imm8),
    CASE("ISA", "LOCK AND m32,imm32", lock_and_imm32),
    CASE("ISA", "LOCK SUB m64,sign-extended imm8", lock_sub_imm8_64),
    CASE("ISA", "LOCK INC m32", lock_inc),
    CASE("ISA", "LOCK DEC m32", lock_dec),
    CASE("machine ABI", "LOCK BTS m64,r64 bit string", lock_bts),
    CASE("machine ABI", "LOCK BTR m64,r64 bit string", lock_btr),
    CASE("machine ABI", "LOCK BTC m64,r64 bit string", lock_btc),
    CASE("ISA", "MOVSQ", movsq),
    CASE("machine ABI", "REP MOVSQ residual state-step", rep_movsq),
    CASE("machine ABI", "REP MOVSD residual state-step", rep_movsd),
    CASE("machine ABI", "REP MOVSB residual state-step", rep_movsb),
    CASE("ISA", "REP STOSD physical recurrence", rep_stosd),
    CASE("machine ABI", "REPE CMPSD residual state-step", repe_cmpsd),
    CASE("machine ABI", "REPE SCASB residual state-step", repe_scasb),
    CASE("machine ABI", "REPNE SCASD residual state-step", repne_scasd),
    CASE("machine ABI", "REPNE LODSB residual state-step", repne_lodsb),
    CASE("ISA", "POP [RSP] post-increment EA", pop_rsp_mem),
    CASE("machine ABI", "CLI", cli),
    CASE("machine ABI", "STI and interrupt shadow", sti),
    CASE("machine ABI", "HLT and wake event", hlt),
    CASE("machine ABI", "WRMSR", wrmsr),
    CASE("machine ABI", "RDMSR", rdmsr),
    CASE("machine ABI", "CPUID", cpuid),
    CASE("machine ABI", "RDTSC virtual source-instruction clock", rdtsc),
    CASE("machine ABI", "IN AL,DX", in_al_dx),
    CASE("machine ABI", "OUT DX,AL", out_dx_al),
    CASE("machine ABI", "MOV CR3,RAX and TLB generation", mov_cr3_rax),
    CASE("machine ABI", "MOV RAX,CR4", mov_rax_cr4),
    CASE("machine ABI", "MOV DS,AX", mov_ds_ax),
    CASE("machine ABI", "MOV DS,[RAX]", mov_ds_rax),
    CASE("machine ABI", "MOV ECX,FS", mov_ecx_fs),
    CASE("machine ABI", "LFS EAX,[RAX]", lfs_eax),
    CASE("machine ABI", "LGS EAX,[RAX]", lgs_eax),
    CASE("machine ABI", "LSS EAX,[RAX]", lss_eax),
    CASE("machine ABI", "LFS RAX,[RAX]", lfs_rax),
    CASE("machine ABI", "LGS RAX,[RAX]", lgs_rax),
    CASE("machine ABI", "LSS RAX,[RAX]", lss_rax),
    CASE("machine ABI", "LGDT m80", lgdt_rax),
    CASE("machine ABI", "LIDT m80", lidt_rax),
    CASE("machine ABI", "SGDT m80", sgdt_rax),
    CASE("machine ABI", "SIDT m80", sidt_rax),
    CASE("machine ABI", "INVLPG m8", invlpg_rax),
    CASE("machine ABI", "LRETQ", lretq),
    CASE("machine ABI", "IRETW", iretw),
    CASE("machine ABI", "IRETD", iretd),
    CASE("machine ABI", "IRETQ", iretq),
    CASE("machine ABI", "SYSCALL", syscall),
    CASE("machine ABI", "SYSRETQ", sysret),
    CASE("machine ABI", "SYSENTER", sysenter),
    CASE("machine ABI", "SYSEXIT", sysexit),
    CASE("machine ABI", "REX.W SYSEXIT", sysexit64),
    CASE("machine ABI", "SWAPGS", swapgs),
    CASE("machine ABI", "INT 0x80", int_80),
    CASE("machine ABI", "SLDT RAX", sldt_rax),
    CASE("machine ABI", "STR RAX", str_rax),
    CASE("machine ABI", "SLDT [RAX]", sldt_mem),
    CASE("machine ABI", "STR [RAX]", str_mem),
    CASE("machine ABI", "VERW AX", verw_ax),
    CASE("machine ABI", "VERW [RAX]", verw_mem),
    CASE("machine ABI", "CALL FAR [RAX]", far_call_mem),
    CASE("machine ABI", "CALL FAR m16:16 [RAX]", far_call_mem16),
    CASE("machine ABI", "JMP FAR [RAX]", far_jump_mem),
    CASE("machine ABI", "FWAIT persistent x87 summary", fwait),
    CASE("machine ABI", "FTST exact zero quotient", ftst),
    CASE("machine ABI", "FXAM physical x87 classification", fxam),
    CASE("machine ABI", "FXTRACT exponent/significand split", fxtract),
    CASE("machine ABI", "F2XM1 bounded exp2 residual", f2xm1),
    CASE("machine ABI", "FYL2X log-product residual", fyl2x),
    CASE("machine ABI", "FYL2XP1 log1p-product residual", fyl2xp1),
    CASE("machine ABI", "FPATAN atan2-and-pop residual", fpatan),
    CASE("machine ABI", "FCOMPP compare and double-pop", fcompp),
    CASE("machine ABI", "FILD qword [RAX]", fild_i64),
    CASE("machine ABI", "FISTTP dword [RAX]", fisttp_i32),
    CASE("machine ABI", "FISTP qword [RAX]", fistp_i64),
    CASE("machine ABI", "FIST dword [RAX]", fist_i32),
    CASE("machine ABI", "FBLD packed BCD [RAX]", fbld_bcd),
    CASE("machine ABI", "FBSTP packed BCD [RAX]", fbstp_bcd),
    CASE("machine ABI", "FNSTCW [RAX]", fnstcw_mem),
    CASE("machine ABI", "FLDCW [RAX]", fldcw_mem),
    CASE("machine ABI", "FNSTSW [RAX]", fnstsw_mem),
    CASE("machine ABI", "FNSTSW AX", fnstsw_ax),
    CASE("machine ABI", "FNSTENV [RAX]", fnstenv_mem),
    CASE("machine ABI", "FLDENV [RAX]", fldenv_mem),
    CASE("machine ABI", "FNSAVE [RAX]", fnsave_mem),
    CASE("machine ABI", "FRSTOR [RAX]", frstor_mem),
    CASE("machine ABI", "FCMOVNB ST0,ST1", fcmovnb_st1),
    CASE("machine ABI", "FUCOMIP ST0,ST1", fucomip_st1),
    CASE("machine ABI", "FUCOMI ST0,ST1", fucomi_st1),
    CASE("machine ABI", "FCOMIP ST0,ST1", fcomip_st1),
    CASE("machine ABI", "FCOMI ST0,ST1", fcomi_st1),
    CASE("machine ABI", "FIMUL dword [RAX]", fimul_i32),
    CASE("machine ABI", "FADD qword [RAX]", fadd_f64),
    CASE("machine ABI", "FADD ST0,ST1", fadd_st1),
    CASE("machine ABI", "FADDP ST1,ST0", faddp_st1),
    CASE("machine ABI", "FMUL qword [RAX]", fmul_f64),
    CASE("machine ABI", "FMUL ST0,ST1", fmul_st1),
    CASE("machine ABI", "FMULP ST1,ST0", fmulp_st1),
    CASE("machine ABI", "FLD dword [RAX]", fld_f32),
    CASE("machine ABI", "FLD ST1", fld_st1),
    CASE("machine ABI", "FXCH ST1", fxch_st1),
    CASE("machine ABI", "FFREE ST1", ffree_st1),
    CASE("machine ABI", "FFREEP ST1", ffreep_st1),
    CASE("machine ABI", "FCOMP dword [RAX]", fcomp_f32),
    CASE("machine ABI", "FCOM dword [RAX]", fcom_f32),
    CASE("machine ABI", "FICOMP word [RAX]", ficomp_i16),
    CASE("machine ABI", "FICOM dword [RAX]", ficom_i32),
    CASE("machine ABI", "FIADD dword [RAX]", fiadd_i32),
    CASE("machine ABI", "FISUB word [RAX]", fisub_i16),
    CASE("machine ABI", "FISUBR word [RAX]", fisubr_i16),
    CASE("machine ABI", "FSUB dword [RAX]", fsub_f32),
    CASE("machine ABI", "FSUBR qword [RAX]", fsubr_f64),
    CASE("machine ABI", "FSUBP ST1,ST0", fsubp_st1),
    CASE("machine ABI", "FSUBRP ST1,ST0", fsubrp_st1),
    CASE("machine ABI", "FST dword [RAX]", fst_f32),
    CASE("machine ABI", "FSTP qword [RAX]", fstp_f64),
    CASE("machine ABI", "FST ST1", fst_st1),
    CASE("machine ABI", "FSTP ST1", fstp_st1),
    CASE("machine ABI", "FDIV dword [RAX]", fdiv_f32),
    CASE("machine ABI", "FDIVR qword [RAX]", fdivr_f64),
    CASE("machine ABI", "FDIVP ST1,ST0", fdivp_st1),
    CASE("machine ABI", "FDIVRP ST1,ST0", fdivrp_st1),
    CASE("machine ABI", "FIDIV dword [RAX]", fidiv_i32),
    CASE("machine ABI", "FIDIVR word [RAX]", fidivr_i16),
    CASE("machine ABI", "MOVQ MM0,[RAX]", movq_mmx_load),
    CASE("machine ABI", "MOVQ [RAX],MM0", movq_mmx_store),
    CASE("machine ABI", "PADDD MM0,MM1", paddd_mmx),
    CASE("machine ABI", "PADDD XMM0,XMM1", paddd_xmm),
    CASE("machine ABI", "PSRLD XMM1,12", psrld_xmm_imm),
    CASE("machine ABI", "PSLLD XMM0,20", pslld_xmm_imm),
    CASE("machine ABI", "PXOR MM0,MM1", pxor_mmx),
    CASE("machine ABI", "PCMPEQB MM0,[RAX]", pcmpeqb_mmx),
    CASE("machine ABI", "PCMPGTD MM0,MM1", pcmpgtd_mmx),
    CASE("machine ABI", "PSRLD MM0,[RAX]", psrld_mmx),
    CASE("machine ABI", "PSLLD MM0,MM1", pslld_mmx),
    CASE("machine ABI", "PSRLD MM1,12", psrld_mmx_imm),
    CASE("machine ABI", "PSLLD MM0,20", pslld_mmx_imm),
    CASE("machine ABI", "PSUBD MM0,[RAX]", psubd_mmx),
    CASE("machine ABI", "PCMPEQW MM0,[RAX]", pcmpeqw_mmx),
    CASE("machine ABI", "PCMPEQD MM0,[RAX]", pcmpeqd_mmx),
    CASE("machine ABI", "PMULLW MM0,[RAX]", pmullw_mmx),
    CASE("machine ABI", "PMULLW XMM5,XMM3", pmullw_xmm),
    CASE("machine ABI", "PCMPEQB XMM7,XMM4", pcmpeqb_xmm),
    CASE("machine ABI", "PSHUFHW XMM2,XMM0,0x50", pshufhw_xmm),
    CASE("machine ABI", "UNPCKLPD XMM5,XMM4", unpcklpd_xmm),
    CASE("machine ABI", "PMOVMSKB EDI,MM7", pmovmskb_mmx),
    CASE("machine ABI", "MOVHLPS XMM6,XMM5", movhlps_xmm),
    CASE("machine ABI", "LDMXCSR [RSP+12]", ldmxcsr_mem),
    CASE("machine ABI", "STMXCSR [RSI+1023]", stmxcsr_mem),
    CASE("machine ABI", "MOVNTQ [RAX],MM0", movntq_mem),
    CASE("machine ABI", "PSUBSW MM0,[RAX]", psubsw_mmx),
    CASE("machine ABI", "PSUBSB MM0,[RAX]", psubsb_mmx),
    CASE("machine ABI", "PADDB MM0,[RAX]", paddb_mmx),
    CASE("machine ABI", "PADDD XMM0,[RAX]", paddd_xmm_mem),
    CASE("machine ABI", "PSHUFD XMM0,XMM1,0x1b", pshufd_xmm),
    CASE("machine ABI", "PSHUFD XMM0,[RAX],0x1b", pshufd_xmm_mem),
    CASE("machine ABI", "PSHUFW MM0,MM1,0x1b", pshufw_mmx),
    CASE("machine ABI", "PSHUFW MM0,[RAX],0x1b", pshufw_mmx_mem),
    CASE("machine ABI", "SHUFPS XMM0,XMM1,0x1b", shufps_xmm),
    CASE("machine ABI", "SHUFPS XMM0,[RAX],0x1b", shufps_xmm_mem),
    CASE("machine ABI", "PSRLQ MM0,MM1", psrlq_mmx),
    CASE("machine ABI", "PSRLQ MM0,[RAX]", psrlq_mmx_mem),
    CASE("machine ABI", "PSLLQ MM0,MM1", psllq_mmx),
    CASE("machine ABI", "PSRLQ MM0,12", psrlq_mmx_imm),
    CASE("machine ABI", "PSLLQ MM0,20", psllq_mmx_imm),
    CASE("machine ABI", "MOVD MM0,[RAX]", movd_mmx_load),
    CASE("machine ABI", "MOVD [RAX],MM0", movd_mmx_store),
    CASE("machine ABI", "EMMS", emms),
    CASE("#UD", "FEMMS rejected without 3DNow!", femms),
    CASE("machine ABI", "PADDW MM0,MM1", paddw_mmx),
    CASE("machine ABI", "PSUBQ MM0,MM1", psubq_mmx),
    CASE("machine ABI", "LFENCE", lfence),
    CASE("machine ABI", "MFENCE", mfence),
    CASE("machine ABI", "SFENCE", sfence),
    CASE("machine ABI", "SERIALIZE", serialize),
    CASE("machine ABI", "WBINVD", wbinvd),
    CASE("machine ABI", "INVD", invd),
    CASE("machine ABI", "CLFLUSH [RAX]", clflush_rax),
    CASE("machine ABI", "CLWB [RAX]", clwb_rax),
    CASE("machine ABI", "FUCOMPP", fucompp),
    CASE("machine ABI", "FLD1", fld1),
    CASE("machine ABI", "FLDL2T", fldl2t),
    CASE("machine ABI", "FLDL2E", fldl2e),
    CASE("machine ABI", "FLDPI", fldpi),
    CASE("machine ABI", "FLDLG2", fldlg2),
    CASE("machine ABI", "FLDLN2", fldln2),
    CASE("machine ABI", "FLDZ", fldz),
    CASE("machine ABI", "RDTSCP", rdtscp),
    CASE("machine ABI", "MOVD XMM0,EDI", movd_xmm_load),
    CASE("machine ABI", "MOVD EDI,XMM0", movd_xmm_store),
    CASE("machine ABI", "MOVD XMM0,[RAX]", movd_xmm_mem),
    CASE("machine ABI", "MOV RBP,DR3", mov_rbp_dr3),
    CASE("machine ABI", "MOV DR3,RBP", mov_dr3_rbp),
    CASE("machine ABI", "LAR ECX,ECX", lar_ecx_ecx),
    CASE("machine ABI", "LAR ECX,[RAX]", lar_ecx_mem),
    CASE("machine ABI", "LSL EAX,[RAX]", lsl_eax_mem),
    CASE("machine ABI", "LLDT [RAX]", lldt_mem),
    CASE("machine ABI", "LLDT AX", lldt_ax),
    CASE("machine ABI", "RDPMC fixed CPU contract", rdpmc),
    CASE("machine ABI", "LMSW [RAX]", lmsw_mem),
    CASE("machine ABI", "LMSW AX", lmsw_ax),
    CASE("machine ABI", "CLTS", clts),
    CASE("machine ABI", "FINCSTP", fincstp),
    CASE("machine ABI", "FDECSTP", fdecstp),
    CASE("machine ABI", "LTR [RAX]", ltr_mem),
    CASE("machine ABI", "LTR AX", ltr_ax),
    CASE("machine ABI", "PUSH FS", push_fs),
    CASE("machine ABI", "POP FS", pop_fs),
    CASE("machine ABI", "PUSH GS", push_gs),
    CASE("machine ABI", "POP GS", pop_gs),
    CASE("machine ABI", "PSADBW MM0,MM1", psadbw_mmx),
    CASE("machine ABI", "UNPCKLPS XMM0,XMM1", unpcklps_xmm),
    CASE("machine ABI", "UNPCKLPS XMM0,[RAX]", unpcklps_mem),
    CASE("machine ABI", "PUNPCKLDQ XMM0,XMM1", punpckldq_xmm),
    CASE("machine ABI", "PUNPCKLDQ XMM0,[RAX]", punpckldq_mem),
    CASE("machine ABI", "PUNPCKHQDQ XMM0,XMM1", punpckhqdq_xmm),
    CASE("machine ABI", "PUNPCKHQDQ XMM0,[RAX]", punpckhqdq_mem),
    CASE("machine ABI", "PSUBB MM0,MM1", psubb_mmx),
    CASE("machine ABI", "PCMPGTW MM0,MM1", pcmpgtw_mmx),
    CASE("machine ABI", "PANDN MM0,MM1", pandn_mmx),
    CASE("machine ABI", "PUNPCKHBW MM0,MM1", punpckhbw_mmx),
    CASE("machine ABI", "PUNPCKHBW MM0,[RAX]", punpckhbw_mem),
    CASE("machine ABI", "PUNPCKHBW XMM0,[RAX]", punpckhbw_xmm_mem),
    CASE("machine ABI", "PMADDWD MM0,MM1", pmaddwd_mmx),
    CASE("machine ABI", "PADDQ MM0,MM1", paddq_mmx),
    CASE("machine ABI", "PMULHUW MM0,MM1", pmulhuw_mmx),
    CASE("machine ABI", "PMINSW MM0,MM1", pminsw_mmx),
    CASE("machine ABI", "PSRLQ XMM2,17", psrlq_xmm),
    CASE("machine ABI", "MOVQ XMM1,RDI", movq_xmm_gpr),
    CASE("machine ABI", "MOVQ RAX,XMM1", movq_gpr_xmm),
    CASE("machine ABI", "CMPXCHG8B [RAX]", cmpxchg8b_mem),
    CASE("machine ABI", "FNINIT", fninit),
    CASE("machine ABI", "PUNPCKHWD MM0,MM1", punpckhwd_mmx),
    CASE("machine ABI", "PSUBW MM0,MM1", psubw_mmx),
    CASE("machine ABI", "PUNPCKLQDQ XMM0,XMM1", punpcklqdq_xmm),
    CASE("machine ABI", "MOVQ MM1,RDI", movq_mmx_gpr),
    CASE("machine ABI", "MOVLPS [RAX],XMM0", movlps_store),
    CASE("machine ABI", "MOVHPS XMM0,[RAX]", movhps_load),
    CASE("machine ABI", "PINSRW MM0,EDI,3", pinsrw_mmx),
    CASE("machine ABI", "PEXTRW ESP,MM3,255", pextrw_mmx),
    CASE("machine ABI", "PEXTRW ESP,XMM3,7", pextrw_xmm),
    CASE("machine ABI", "PSLLDQ XMM1,12", pslldq_xmm),
    CASE("machine ABI", "PSRLDQ XMM0,8", psrldq_xmm),
    CASE("machine ABI", "PMULUDQ MM0,MM1", pmuludq_mmx),
    CASE("machine ABI", "PCMPGTB MM0,MM1", pcmpgtb_mmx),
    CASE("machine ABI", "PMULHW MM0,MM1", pmulhw_mmx),
    CASE("machine ABI", "PACKUSWB MM0,MM1", packuswb_mmx),
    CASE("machine ABI", "PACKUSWB XMM0,XMM1", packuswb_xmm),
    CASE("machine ABI", "PADDSW MM0,MM1", paddsw_mmx),
    CASE("machine ABI", "PSLLW MM0,MM1", psllw_mmx),
    CASE("machine ABI", "PSLLW XMM0,XMM1", psllw_xmm),
    CASE("machine ABI", "PMAXSW MM0,MM1", pmaxsw_mmx),
    CASE("machine ABI", "PSUBUSB MM0,MM1", psubusb_mmx),
    CASE("machine ABI", "PADDUSB MM0,MM1", paddusb_mmx),
    CASE("machine ABI", "PAVGB MM0,MM1", pavgb_mmx),
    CASE("machine ABI", "PAVGW MM0,MM1", pavgw_mmx),
    CASE("machine ABI", "PMAXUB MM0,MM1", pmaxub_mmx),
    CASE("machine ABI", "PSRAD MM0,MM1", psrad_mmx),
    CASE("machine ABI", "PADDUSB XMM0,XMM1", paddusb_xmm),
    CASE("machine ABI", "PAVGB XMM0,XMM1", pavgb_xmm),
    CASE("machine ABI", "PAVGW XMM0,XMM1", pavgw_xmm),
    CASE("machine ABI", "PMAXUB XMM0,XMM1", pmaxub_xmm),
    CASE("machine ABI", "PSRAD XMM0,XMM1", psrad_xmm),
    CASE("machine ABI", "MOVNTPS [RAX],XMM0", movntps_mem),
    CASE("machine ABI", "UNPCKHPS XMM0,XMM1", unpckhps_xmm),
    CASE("machine ABI", "PUNPCKHDQ MM0,MM1", punpckhdq_mmx),
    CASE("machine ABI", "PUNPCKLBW MM0,[RAX]", punpcklbw_mmx_mem),
    CASE("machine ABI", "PACKSSDW MM0,MM1", packssdw_mmx),
    CASE("machine ABI", "PADDSB MM0,MM1", paddsb_mmx),
    CASE("machine ABI", "PADDUSW MM0,MM1", paddusw_mmx),
    CASE("machine ABI", "PMINUB MM0,MM1", pminub_mmx),
    CASE("machine ABI", "PSRAW MM0,MM1", psraw_mmx),
    CASE("machine ABI", "PSRLW MM0,MM1", psrlw_mmx),
    CASE("machine ABI", "PACKSSWB MM0,MM1", packsswb_mmx),
    CASE("machine ABI", "PSUBUSW MM0,MM1", psubusw_mmx),
    CASE("machine ABI", "PUNPCKLDQ MM0,[RAX]", punpckldq_mmx_mem),
    CASE("machine ABI", "PUNPCKLWD MM0,[RAX]", punpcklwd_mmx_mem),
    CASE("machine ABI", "PUNPCKLWD XMM0,XMM1", punpcklwd_xmm),
    CASE("machine ABI", "FNCLEX", fnclex),
    CASE("machine ABI", "FCOS", fcos),
    CASE("machine ABI", "FSIN", fsin),
    CASE("machine ABI", "FSINCOS", fsincos),
    CASE("machine ABI", "FPTAN", fptan),
    CASE("machine ABI", "FSTPNCE", fstpnce),
    CASE("machine ABI", "FRNDINT", frndint),
    CASE("machine ABI", "FSCALE", fscale),
    CASE("machine ABI", "FSQRT", fsqrt),
    CASE("machine ABI", "FXSAVE [RAX]", fxsave),
    CASE("machine ABI", "FXSAVE64 [RAX]", fxsave64),
    CASE("machine ABI", "FXRSTOR [RAX]", fxrstor),
    CASE("machine ABI", "FXRSTOR64 [RAX]", fxrstor64),
    CASE("machine ABI", "CVTDQ2PS XMM0,XMM3", cvtdq2ps),
    CASE("machine ABI", "CVTTPS2PI MM0,XMM3", cvttps2pi),
    CASE("machine ABI", "CVTPS2PI MM0,XMM3", cvtps2pi),
    CASE("machine ABI", "CVTPS2PI MM3,[RAX]", cvtps2pi_mem),
    CASE("machine ABI", "CVTPI2PS XMM7,MM4", cvtpi2ps_reg),
    CASE("machine ABI", "CVTPI2PS XMM7,[RAX]", cvtpi2ps_mem),
    CASE("machine ABI", "CVTPS2PD XMM0,XMM1", cvtps2pd_reg),
    CASE("machine ABI", "CVTPS2PD XMM0,[RAX]", cvtps2pd_mem),
    CASE("machine ABI", "CVTTPD2PI MM3,XMM1", cvttpd2pi_reg),
    CASE("machine ABI", "CVTTPD2PI MM3,[RAX]", cvttpd2pi_mem),
    CASE("machine ABI", "MASKMOVQ MM0,MM1", maskmovq),
    CASE("machine ABI", "SQRTPS XMM0,XMM3", sqrtps),
    CASE("machine ABI", "RCPPS XMM0,XMM1", rcpps_reg),
    CASE("machine ABI", "RCPPS XMM0,[RAX]", rcpps_mem),
    CASE("machine ABI", "RSQRTPS XMM0,XMM1", rsqrtps_reg),
    CASE("machine ABI", "RSQRTPS XMM0,[RAX]", rsqrtps_mem),
    CASE("machine ABI", "MULPS XMM0,XMM1", mulps_reg),
    CASE("machine ABI", "MULPS XMM0,[RAX]", mulps_mem),
    CASE("machine ABI", "SUBPS XMM0,XMM1", subps_reg),
    CASE("machine ABI", "SUBPS XMM0,[RAX]", subps_mem),
    CASE("machine ABI", "DIVPS XMM0,XMM1", divps_reg),
    CASE("machine ABI", "DIVPS XMM0,[RAX]", divps_mem),
    CASE("machine ABI", "FPREM", fprem),
    CASE("machine ABI", "FPREM1", fprem1),
    CASE("machine ABI", "FCHS", fchs),
    CASE("machine ABI", "FABS", fabs_x87),
    CASE("machine ABI", "CMPPS XMM0,XMM3,EQ", cmpps),
    CASE("machine ABI", "CMPPS XMM3,[RAX],EQ", cmpps_mem),
    CASE("machine ABI", "CMPPS masks imm8 to a predicate", cmpps_mem_high),
    CASE("machine ABI", "ADDPS XMM0,XMM3", addps),
    CASE("machine ABI", "ADDPS XMM3,[RAX]", addps_mem),
    CASE("machine ABI", "MAXPS XMM0,[RAX]", maxps_mem),
    CASE("machine ABI", "MINPS XMM0,[RAX]", minps_mem),
    CASE("machine ABI", "UCOMISS XMM0,XMM1", ucomiss),
    CASE("machine ABI", "UCOMISS XMM0,[RAX]", ucomiss_mem),
    CASE("machine ABI", "COMISS XMM0,XMM1", comiss),
    CASE("machine ABI", "RDRAND RDX", rdrand_rdx),
    CASE("machine ABI", "RDSEED RAX", rdseed_rax),
    CASE("#UD", "JKNZD rejected by the fixed non-KNC CPU", jknzd_knc),
    CASE("#UD", "VPXOR rejected without AVX/OSXSAVE", vpxor_avx),
    CASE("#UD", "PSHUFB rejected without SSSE3", pshufb_ssse3),
    CASE("#UD", "CLAC rejected without SMAP", clac_smap),
    CASE("#UD", "XBEGIN rejected without RTM", xbegin_rtm),
    CASE("#UD", "SHA256RNDS2 rejected without SHA", sha256rnds2),
    CASE("#UD", "PCLMULQDQ rejected without PCLMUL", pclmulqdq),
    CASE("#UD", "CLFLUSHOPT rejected without CLFLUSHOPT", clflushopt_rax),
    CASE("#UD", "INVLPGB rejected by the fixed Intel CPU", invlpgb),
    CASE("#UD", "GETSEC rejected without SMX", getsec_smx),
    CASE("#UD", "MWAIT rejected without MONITOR", mwait_monitor),
    CASE("#UD", "VMREAD rejected without VMX", vmread_vtx),
    CASE("#UD", "BNDLDX rejected without MPX", bndldx_mpx),
    CASE("#UD", "XRSTOR rejected without XSAVE", xrstor_xsave),
    CASE("#UD", "XSAVEOPT rejected without XSAVE", xsaveopt),
    CASE("#UD", "RSM rejected outside SMM", rsm_no_smm),
    CASE("#UD", "PEXTRD rejected without SSE4.1", pextrd_sse4),
    CASE("#UD", "INVPCID rejected without INVPCID", invpcid_no_feature),
    CASE("#UD", "CLDEMOTE rejected without CLDEMOTE", cldemote_no_feature),
    CASE("#UD", "PAVGUSB rejected without 3DNow!", pavgusb_3dnow),
    CASE("#UD", "PBNDKB rejected by the fixed CPU", pbndkb_no_feature),
    CASE("#UD", "RDPID rejected without RDPID", rdpid_no_feature),
    CASE("#UD", "TILERELEASE rejected without AMX-TILE",
         tilerelease_no_feature),
    CASE("#UD", "TPAUSE rejected without WAITPKG", tpause_no_feature),
    CASE("#UD", "XSHA256 rejected on the fixed Intel CPU",
         xsha256_padlock),
};

int main(void)
{
    pl_u32 failures = 0u;
    pl_u32 isa_failures = 0u;
    pl_u32 machine_failures = 0u;
    for (pl_u32 index = 0u;
            index < (pl_u32)(sizeof cases / sizeof cases[0]); ++index) {
        const closure_case *test = &cases[index];
        pl_x86_map map = {
            test->bytes, 0x1000u, test->byte_count, test->byte_count,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
        };
        pl_x86_image image = { &map, 1u, 0u, 0x1000u };
        pl_x86_instruction instruction = { 0 };
        pl_x86_semantic semantic;
        pl_u8 storage[4096];
        pl_arena arena = { storage, sizeof storage, 0u };
        int status = pl_x86_image_validate(&image);
        if (!status) status = pl_x86_decode(&image, image.entry, &instruction);
        if (!status) {
            if (instruction.status != PL_X86_DECODE_VALID)
                status = PL_ERROR_X86;
            else if (instruction.flow != PL_X86_FLOW_FAULT)
                status = pl_x86_lower(&instruction, &arena, &semantic);
        }
        /* System transfer is a block cut even after its direct ABI action is
         * implemented.  IRETQ was once accepted as an ordinary RET merely
         * because both use Zydis's RET category; require the machine cut as
         * well as a lowerable action so that misclassification is red. */
        if (!status && test->domain[0] != 'I'
                && test->domain[0] != '#'
                && !(instruction.flags & PL_X86_INSTRUCTION_BARRIER))
            status = PL_ERROR_X86_SEMANTIC;
        if (!status && test->domain[0] == 'm'
                && instruction.machine_operation == PL_X86_MACHINE_NONE)
            status = PL_ERROR_X86_SEMANTIC;
        if (!status && test->domain[0] == '#'
                && (instruction.operation != PL_X86_OPERATION_FAULT
                    || instruction.trap_vector != 6u))
            status = PL_ERROR_X86_SEMANTIC;
        if (!status) continue;

        ++failures;
        if (test->domain[0] == 'I') ++isa_failures;
        else ++machine_failures;
        fprintf(stderr,
                "%-11s RED  %-34s status=%d anonymous-barrier=%u\n",
                test->domain, test->name, status,
                status == PL_ERROR_X86_SEMANTIC
                    && !!(instruction.flags & PL_X86_INSTRUCTION_BARRIER));
        for (pl_u32 operand = 0u;
                operand < instruction.visible_operand_count; ++operand) {
            const pl_x86_operand *value = &instruction.operands[operand];
            fprintf(stderr,
                    "  operand[%u] kind=%u bits=%u class=%u index=%u immediate=%llu\n",
                    operand, value->kind, value->bits,
                    value->kind == PL_X86_OPERAND_REGISTER
                        ? value->value.reg.class_id : 0u,
                    value->kind == PL_X86_OPERAND_REGISTER
                        ? value->value.reg.index : 0u,
                    (unsigned long long)(value->kind
                        == PL_X86_OPERAND_IMMEDIATE
                        ? value->value.immediate : 0u));
        }
    }
    if (failures) {
        fprintf(stderr,
                "direct semantic completeness: RED (%u ISA, %u machine ABI witnesses)\n",
                isa_failures, machine_failures);
        return 1;
    }
    printf("direct semantic completeness: green (%u witnesses)\n",
           (pl_u32)(sizeof cases / sizeof cases[0]));
    return 0;
}

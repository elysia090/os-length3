// SSE and SSE2, x86-64's baseline: every packed instruction a compiler
// emits for them, on many inputs and the edges (NaN, both zeros,
// infinities, values out of an integer's range, denormals), each folded
// into a hash printed with its name. The CPU's answer is the reference.
#include <emmintrin.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint64_t seed = 0x9e3779b97f4a7c15u;
static uint64_t next(void) { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; return seed; }

static const float F[] = {0.0f, -0.0f, 1.0f, -1.0f, 0.5f, 1.5f, 2.5f, -2.5f, INFINITY, -INFINITY, NAN, -NAN,
  2147483520.0f, 2147483648.0f, -2147483648.0f, -2147483904.0f, 1e-40f, -1e-40f, 3.4e38f, 1e10f, -1e10f, 7.25f};
static const double D[] = {0.0, -0.0, 1.0, -1.0, 0.5, 1.5, 2.5, -2.5, INFINITY, -INFINITY, NAN, -NAN,
  2147483647.0, 2147483647.5, 2147483648.0, -2147483648.0, -2147483648.5, -2147483649.0, 1e-310, 1e300, -1e20, 7.25};
#define NF (sizeof F / sizeof *F)
#define ND (sizeof D / sizeof *D)

static float pickf(void) { uint64_t r = next(); if (r & 1) return F[(r >> 1) % NF]; float f; uint32_t u = (uint32_t)(r >> 8); memcpy(&f, &u, 4); return (r & 2) ? f : (float)(int32_t)(r >> 20) / 64.0f; }
static double pickd(void) { uint64_t r = next(); if (r & 1) return D[(r >> 1) % ND]; double d; uint64_t u = next(); memcpy(&d, &u, 8); return (r & 2) ? d : (double)(int64_t)(r >> 12) / 1024.0; }

static __m128 ps(void) { return _mm_setr_ps(pickf(), pickf(), pickf(), pickf()); }
static __m128d pd(void) { return _mm_setr_pd(pickd(), pickd()); }
static __m128i pi(void) { uint64_t a = next(), b = next(); if (a % 5 == 0) a = 0x8000800080008000u ^ (b & 0x00ff00ff00ff00ffu); return _mm_set_epi64x((long long)a, (long long)b); }

static uint64_t h;
static void mix(const void *p) { uint64_t w[2]; memcpy(w, p, 16); h = (h ^ w[0]) * 0x100000001b3u; h = (h ^ w[1]) * 0x100000001b3u; h ^= h >> 29; }
#define N 20000
#define RUN(name, ...) do { h = 0xcbf29ce484222325u; for (int k = 0; k < N; k++) { __VA_ARGS__ } printf("%-10s %016llx\n", name, (unsigned long long)h); } while (0)
#define MIXS(e) do { __m128 r_ = (e); mix(&r_); } while (0)
#define MIXD(e) do { __m128d r_ = (e); mix(&r_); } while (0)
#define MIXI(e) do { __m128i r_ = (e); mix(&r_); } while (0)

// A NaN's payload as each operation passes it on: the CPU's quiet NaN of the first operand that is one.
int main(void) {
  RUN("sqrtps", MIXS(_mm_sqrt_ps(ps())););
  RUN("sqrtpd", MIXD(_mm_sqrt_pd(pd())););
  RUN("maxps", __m128 a = ps(), b = ps(); MIXS(_mm_max_ps(a, b)););
  RUN("minps", __m128 a = ps(), b = ps(); MIXS(_mm_min_ps(a, b)););
  RUN("maxpd", __m128d a = pd(), b = pd(); MIXD(_mm_max_pd(a, b)););
  RUN("minpd", __m128d a = pd(), b = pd(); MIXD(_mm_min_pd(a, b)););
  RUN("cmpps", __m128 a = ps(), b = ps(); MIXS(_mm_cmpeq_ps(a, b)); MIXS(_mm_cmplt_ps(a, b)); MIXS(_mm_cmple_ps(a, b));
    MIXS(_mm_cmpunord_ps(a, b)); MIXS(_mm_cmpneq_ps(a, b)); MIXS(_mm_cmpnlt_ps(a, b)); MIXS(_mm_cmpnle_ps(a, b)); MIXS(_mm_cmpord_ps(a, b)););
  RUN("cmppd", __m128d a = pd(), b = pd(); MIXD(_mm_cmpeq_pd(a, b)); MIXD(_mm_cmplt_pd(a, b)); MIXD(_mm_cmple_pd(a, b));
    MIXD(_mm_cmpunord_pd(a, b)); MIXD(_mm_cmpneq_pd(a, b)); MIXD(_mm_cmpnlt_pd(a, b)); MIXD(_mm_cmpnle_pd(a, b)); MIXD(_mm_cmpord_pd(a, b)););
  RUN("unpckps", __m128 a = ps(), b = ps(); MIXS(_mm_unpacklo_ps(a, b)); MIXS(_mm_unpackhi_ps(a, b)););
  RUN("cvtdq2ps", MIXS(_mm_cvtepi32_ps(pi())););
  RUN("cvtdq2pd", MIXD(_mm_cvtepi32_pd(pi())););
  RUN("cvtps2pd", MIXD(_mm_cvtps_pd(ps())););
  RUN("cvtpd2ps", MIXS(_mm_cvtpd_ps(pd())););
  RUN("cvttps2dq", MIXI(_mm_cvttps_epi32(ps())););
  RUN("cvtps2dq", MIXI(_mm_cvtps_epi32(ps())););
  RUN("cvttpd2dq", MIXI(_mm_cvttpd_epi32(pd())););
  RUN("cvtpd2dq", MIXI(_mm_cvtpd_epi32(pd())););
  RUN("pmuludq", __m128i a = pi(), b = pi(); MIXI(_mm_mul_epu32(a, b)););
  RUN("pmulhw", __m128i a = pi(), b = pi(); MIXI(_mm_mulhi_epi16(a, b)););
  RUN("pmulhuw", __m128i a = pi(), b = pi(); MIXI(_mm_mulhi_epu16(a, b)););
  RUN("pmaddwd", __m128i a = pi(), b = pi(); MIXI(_mm_madd_epi16(a, b)););
  RUN("psadbw", __m128i a = pi(), b = pi(); MIXI(_mm_sad_epu8(a, b)););
  RUN("maskmov", __m128i a = pi(), m = pi(); __m128i buf = pi(); _mm_maskmoveu_si128(a, m, (char *)&buf); MIXI(buf););
  RUN("movnt", __m128i a = pi(); __m128i buf[2]; _mm_stream_si128(&buf[0], a); _mm_stream_pd((double *)&buf[1], pd()); _mm_sfence();
    MIXI(buf[0]); MIXI(buf[1]); int x; _mm_stream_si32(&x, (int)next()); MIXI(_mm_cvtsi32_si128(x)););
  // Approximations each CPU makes its own way: within the 1.5 * 2^-12 x86 promises.
  int close = 1;
  for (int k = 0; k < N; k++) {
    float v = fabsf(pickf());
    if (!(v > 1e-30f && v < 1e30f)) continue;
    float r[4], q[4];
    _mm_storeu_ps(r, _mm_rcp_ps(_mm_set1_ps(v)));
    _mm_storeu_ps(q, _mm_rsqrt_ps(_mm_set1_ps(v)));
    if (fabs(r[0] * (double)v - 1) > 1.5 / 4096 || fabs(q[0] * sqrt((double)v) - 1) > 1.5 / 4096) close = 0;
  }
  printf("rcp/rsqrt  %s\n", close ? "within 1.5 * 2^-12" : "off");
  unsigned csr = _mm_getcsr();
  _mm_setcsr(csr);
  printf("mxcsr      %04x\n", csr & 0xffc0);
  _mm_clflush(&h);
  _mm_mfence(); _mm_lfence();
  return 0;
}

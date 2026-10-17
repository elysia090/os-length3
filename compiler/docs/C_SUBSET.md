# The built-in C subset

This describes `qm/cfront/`, the frontend used when no Clang/WASM bundle can be
reached. With Clang available the subset does not apply: anything Clang compiles
can be analysed, and only the *signature* has to be readable (one integer
argument, one integer return of at most 64 bits).

## Supported

**Types.** `_Bool`/`bool`, `char`, `short`, `int`, `long`, `long long` with
`signed`/`unsigned`, the `<stdint.h>` fixed-width typedefs, `size_t`,
`intptr_t`, `__int128`. LP64: `int` is 32-bit, `long` is 64-bit.

**Statements.** declarations, `if`/`else`, `for`, `while`, `do`/`while`,
`switch`/`case`/`default` with fallthrough, `break`, `continue`, `return`,
blocks, local arrays with constant length and brace initializers.

**Expressions.** the full C operator set except pointer operators: assignment
and compound assignment, `?:`, `||`, `&&`, bitwise, comparison, shifts,
arithmetic, unary `+ - ~ !`, prefix/postfix `++ --`, casts, `sizeof(type)`,
array indexing, calls to other functions in the same paste.

**Preprocessor.** `#include <…>` is ignored, object-like `#define` is expanded.

**Builtins.** `__builtin_popcount{,l,ll}`, `__builtin_parity{,l,ll}`,
`__builtin_ctz{,l,ll}`, `__builtin_clz{,l,ll}`, `__builtin_bswap{16,32,64}`,
`__builtin_expect`, `__builtin_rotate{left,right}{32,64}`, `abs`/`labs`.

## Not supported

Pointers, structs, unions, enums, floating point, string literals as values,
`goto`, variadic functions, function-like macros, conditional compilation,
`typedef`, file-scope variables, and multi-argument kernels.

Each of these is *reported* with a line, a column and a suggestion. None of them
is silently ignored — a frontend that quietly drops a construct changes the
semantics it is supposed to extract.

## Documented semantic choices

* Signed overflow wraps two's complement. Real C leaves it undefined; the report
  records the choice instead of pretending the question does not arise.
* Plain `char` is signed, matching x86-64 SysV.
* Shifting by at least the promoted operand width is rejected as an error, not
  masked. Masking would silently produce a different function.
* `__builtin_ctz(0)` and `__builtin_clz(0)` are errors.
* Each call has a step budget; a runaway loop fails with a diagnostic rather
  than hanging the page.

## Two implementations, one meaning

`interp.py` is the reference: a tree-walking evaluator that also counts the
primitive operations executed, which is where the "before" number comes from
when no compiler is available.

`compile.py` compiles the same AST to Python closures with all types resolved
once. It is 20-50x faster, which is what makes a 2^16 domain tractable without a
compiler, and it computes no statistics.

`tests/test_cfront.py` runs both over whole input domains and requires that they
agree — including on which inputs raise. The fast path is only trustworthy while
that holds.

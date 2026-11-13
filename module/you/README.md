# you — the tools a person reaches for

Two programs, each a unit of C on `../lib` with no C library, made to a bound counted by hand: `you` (the places
one has been, and back to one by a part of its name: zoxide's) and `rg` (a tree searched: ripgrep's, on regular
expressions of its own). Each prints what the one it stands in for prints, and is checked beside it.

```
src/you.c        the places you have been: learnt in five calls, found in four
src/rg.c         a tree searched: the walk and the run
src/rg/          what it was asked (options.h), which files it takes (ignore.h, types.h), what it prints (print.h)
src/re/          the regular expressions, a file a step of a pattern's way through them (automaton.h lists them)
make/            what makes the two tables (rg's kinds of file, Unicode past ASCII) from ripgrep's own answers
test/            beside ripgrep and zoxide: rg.sh, regex.sh and its corpus, you.sh, you-stress.sh
```

```
sh ../lib/build.sh src/rg.c rg && sh test/rg.sh RIPGREP ./rg     118 cases, what each prints and how it ends
sh test/regex.sh RIPGREP                                         124 patterns, nine ways each
sh ../lib/build.sh src/you.c you && sh test/you.sh ./you && sh test/you-stress.sh ./you
```

## Why one thread is enough

A search is one pass over the text at the pace memory gives it, and whatever is not that pass is taken away.

- **The text is never copied.** A file is mapped, searched where it lies and printed from where it lies.
- **Nothing is looked at twice.** What is not printed is not looked at for a NUL (a count, a file's name, a search
  that finds little pass over the text once); what is printed is looked at as it is printed, 4 KiB at a time,
  which the search has just had in its hands.
- **A line is found by its rarest bytes, not by the automaton.** Before anything is run, what every match must
  hold is read off the pattern (`re/literal.h`): a literal, the few literals a match begins with one of, or the
  ranges its first bytes are in. The text is then two compares and an AND for 32 places at once (`re/find.h`), and
  the automaton is asked only where those say it may match, anchored there: it reads the bytes beside the place and
  no more of the line.
- **The automaton, where it is asked, is two loads and a test a byte** (`re/dfa.h`: a DFA made as it runs, four
  lines' stretches at once where a whole text must be run).

## The bound, and where each search stands

Instructions for each byte of text (callgrind, 110 MB of this repository's sources, one thread). The bound is
counted by hand for 32-byte registers: a step of 64 places is its loads, its compares, one mask and its test.
Beside ripgrep 15.2.0 on one thread (`-j1`), the same machine: its time over ripgrep's, under 1 the faster.

| Search | By hand | Was | Now | Beside ripgrep |
| --- | --- | --- | --- | --- |
| a literal seldom there (`RESOLVE_BENEATH`) | 0.16: 8 compares, 4 ANDs, 3 ORs, a mask for 128 places | 0.37 | 0.22 | 0.78 |
| the same, case aside (`-i`) | 0.28: either case of each byte | 0.53 | 0.38 | 0.33 |
| a common word (`the`) | its lines, each found once | 1.43 | 1.26 | 0.89 |
| a word between its edges (`-w for`, `\bfor\b`) | 0.27 and a few bytes beside each place | 1.89 | 0.69 | 0.70 |
| one of two words (`TODO\|FIXME`) | 0.39: 8k + 9 for 64 places, k words | 1.73 | 0.42 | 0.40 |
| one of three (`foo\|bar\|baz`) | 0.64 (four words' loop) | 3.06 | 0.92 | 0.87 |
| first bytes in ranges (`[A-Z]{3,}_[A-Z]+`) | not counted yet | 3.09 | 2.94 | 0.89 |
| the automaton over every byte (`\w+_\w+\(`) | 4: two loads, a test, a step | 3.43 | 3.43 | 0.38 |
| each match of a line (`-o [a-z]+ing`) | not counted yet | 7.91 | 7.75 | 1.22 |
| lines without (`-v the`) | its lines, each found once | 2.81 | 2.65 | 0.62 |

What is over, and next: a literal's scan is 26 instructions a step where 21 are counted (its two places are added
to the text's address at each load); the ranges' scan loads its bounds again at every step; each match of a line
(`-o`) is found by the automaton forwards and then backwards, where a literal the match ends with would give its
place. With 64-byte registers a step is a third of these; they are not used (a browser has 16-byte ones: every
scan here has its 16-byte way, which `test/regex.sh` runs too).

`you add` is 3,600 instructions and five calls (newfstatat, open, flock, fstat, write); `you query` 3,900 and four.

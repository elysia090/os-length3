// sods as others take it, the first of three files: a program made a module, and that module kept. What is outside
// sods imports this, linux.ts and host.ts and nothing under them (scripts/units.ts checks it), so what sods is made
// of can change without anyone else's code changing.
//
//   loadTranslator   the translator (sods.wasm), loaded: a program's bytes in, a module's out; what it refuses is
//                    NotAProgram, the file's fault and never the translator's
//   aheadOf          a program translated whole before its first run, prepared as a Linux here runs it
//   prepare          a translation as a Linux here runs it: its memory shared or not, its data beside it
//   packMain, packMore, unpackMore, taken
//                    the form a translation is kept in between runs, and read back from
//   madeBy           what a kept translation is good for, as a name: kept under another, it is never read for this
export {loadTranslator, NotAProgram, type Translate} from './translation/translator.ts';
export {aheadOf, type Ahead, type Held} from './translation/ahead.ts';
export {prepare, type Segment} from './translation/share.ts';
export {MORE, madeBy, packMain, packMore, taken, unpackMore, type More, type Taken} from './translation/kept.ts';

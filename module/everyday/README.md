# everyday — the look and feel, changed by the one who uses it

ricebox has no window of its own. It has this: the layer a face is drawn through, so that whatever face it is
given (root3's pages, a terminal, someone's own), its look is one thing, said one way, and the person's to change.

A look is a sheet: names and their values (a stylesheet's custom properties: colours, faces, sizes, spaces,
corners, the pace of what moves). A person's changes are a few lines in a file of their own:

```
# ~/.everyday
ground: #e9e4d8
ink: #1c1b19
sans: Atkinson Hyperlegible
pace: 0.5
```

everyday reads the sheet for what may be changed, holds the lines to it, and gives the face one rule that makes
them so. That is all of it (`src/everyday.ts`: `things`, `change`).

**It knows no product, and no product is broken through it.** It depends on nothing and is told nothing of what a
face is for. A person may change nearly everything a look is made of, and whatever they write, the face they
changed still does everything it did: what comes out of everyday is values for names the face's own sheet already
has, each of its kind and within its bounds, with every word still read on its ground. No rule of the person's
own, no selector, no script, nothing the face did not already draw with.

- **What may be changed is what the sheet says once, plainly, for every window.** A colour, a length, a time, a
  number, a share, a face. A value made of others (`var()`, `calc()`, a mix) follows them; one the sheet itself
  changes by the window is the sheet's. Nothing is listed anywhere else: the sheet a face is drawn from is the
  list, and `node src/list.ts SHEET...` prints it, each with what the sheet says of it.
- **Each change is held to its kind and to bounds.** A colour is `#rgb` or `#rrggbb`. A length is between half
  and twice what it was; a time from none to four times; a number from a quarter to four times; a share from none
  to all. A face is its families' names, and the sheet's own come after it, for the letters it has not.
- **Words stay read.** A face says which words stand on which grounds. The look is read as a whole (a dark
  ground and light words are taken together, in either order); while a pair would not be read, the line written
  last among those that changed it is left out.
- **A line that is wrong is left out and said, and the rest stands.** What it would have changed stays as it was.
  Nothing a person wrote is put in the rule as it came: each value is read, and written again from what was read.
- **The way back is the file.** A line taken out is that thing as it was; no file is everything as it was. There
  is no state besides it, nothing to reset, nothing to migrate.

```
node src/list.ts SHEET...                    what may be changed: name, kind, usual value, how far it may go
node src/list.ts --changes FILE SHEET...     the rule FILE's lines make, and each line left out, with why
node --test test/everyday.test.ts
```

## Beside a compositor's config

What a person changes a look by, elsewhere, is a program's settings: hundreds of words, each with a grammar of
its own, some checked and some not, their usual values in a manual, the way back a copy kept by hand. Here the
words are the sheet's own, so there are exactly as many as the look has values; a value has one of six kinds and
is checked as that; the usual value is the sheet's; and the way back is to take the line out.

## In root3

root3's pages are one face. Their sheets are `root3/app/styles`; what of them may be changed is written into the
app by `scripts/look.ts` (`root3/app/ui/look-things.ts`), and a person's lines are the dotfile `.everyday`, kept
and brought to each device as every dotfile is (Runtime shows and edits it). `root3/app/ui/look.ts` wears it, with
the words that must stay read on the OS's grounds. Nothing of root3 is known here.

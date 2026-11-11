# prompt — a box someone works in

muk runs a box. A Prompt is a box with someone at it (a person, or a program in a person's place), and what of it is
there the next time. Two concerns, neither of them the machine's:

- **Its terminal.** The other end of the terminal muk makes in the box: what is typed and shown there, its size as
  it changes, who is at it and whether anyone is (a Prompt left, and come back to).
- **What is kept.** A box still there when no one is at it and when what started it is gone: its name, the list of
  them, how each ends. And what a Prompt writes, each part with its owner's lifetime: the repo's environment and its
  caches kept from one of its Prompts to the next, /tmp gone with each.

## The boundary with muk

| | muk gives | prompt does with it |
| --- | --- | --- |
| a box | `muk run -b BUNDLE`: one run is a box's whole life; muk ends as the box ends, and a signal sent to muk is the box's | writes the bundle (what is mounted where, so that what is kept is kept); starts it; knows it by the process it started |
| its terminal | `--console-socket PATH`, with `process.terminal`: the terminal made in the box's own /dev/pts and made the box's; its other end sent to PATH, one descriptor, and closed | listens at PATH; everything a terminal is to the one at it |

That is all that crosses. muk has no name for a box, no list of them, nothing on disk about one, and keeps no end of
a terminal: with no one to take it, there is no terminal. prompt never reaches into a box but through what muk gave
it, and knows nothing of namespaces, mounts, capabilities or the filter: the floor is muk's whatever prompt asks.
`scripts/units.ts` holds it: muk takes nothing of prompt's; prompt takes muk.

One seam is still to be cut, for density: `muk run` stays for its box's whole life (68 KB resident each), because a
run is waited for. A keeper of many boxes waits for them itself (as their parent's parent, a subreaper), and then
needs muk only until the box's program is started.

## Where it is today

Not here yet. On Linux it is in root3's core, beside the box that is muk's to replace
(`root3/core/src/prompt`: `running.rs`, the Prompts that are running and what each holds; `writes.rs`, what a Prompt
writes and how long each part lives; in `launch.rs`, the terminal's group, TERM, and the first process that ends
everything left). In a page it is `root3/app/prompt` (the box's calls answered by muk's runtime; what is kept from
one load of the page to the next), with four files that still reach into the app for its words, its host, its repos
and the Remote's address (`scripts/units.ts`, OWED): what a Prompt is told, not what it asks for.

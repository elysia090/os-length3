# muk — what is at rest

Bytes kept, named by their digest: the root's packs, each file of them read
when it is first touched and checked against its table (`runtime/pack.ts`,
`runtime/table.ts`); copies a Prompt keeps between runs, sealed by their
digest (`runtime/keeper.ts`; what a translation's copy holds is sods'
`kept.ts`); and the repo a shell works in kept in step with the outside
(`runtime/mirror.ts`). The root itself (`../root`: pins, recipes,
settings) and the Remote's bytes are muk's too, and come here as the work goes on.

Its tests run with ricebox's (`sh ../ricebox/tests/programs/run.sh`). A Prompt puts the three together
(`src/app/prompt/kernel.worker.ts`): the box, the root around it, and what was kept.

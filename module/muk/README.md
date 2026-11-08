# muk — what is at rest

Bytes kept, named by their digest: the root's packs, each file of them read
when it is first touched and checked against its table (`runtime/pack.ts`,
`runtime/table.ts`); the translations a Prompt keeps by digest
(`runtime/keeper.ts`); and the repo a shell works in kept in step with the
outside (`runtime/mirror.ts`). The root itself (`../root`: pins, recipes,
settings) and the Remote's bytes are muk's too, and come here as the work goes on.

Its tests run with ricebox's (`sh ../ricebox/tests/run.sh`).

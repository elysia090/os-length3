# Ricebox

Use the distribution if you need an assembled Linux filesystem or want to
embed its execution. Use one of the components directly if you need only
translation, native container execution or a command-line tool.

| Component | What it provides |
| --- | --- |
| [Distribution](distribution/) | Pinned package recipes, native archives, web layers, deployment adapters, and an embeddable execution API. |
| [Sods](sods/) | Static x86-64 Linux program translation and guest Linux services. The host and caller choose the supported execution profile. |
| [Muk](muk/) | A native x86-64 Linux OCI bundle runner. It does not read images or own the frontend terminal. |
| [You](you/) | Freestanding C directory history and tree search commands. |
| [Cowboy](cowboy/) | Guest network adapters and a relay protocol. Product identity and relay authorization are supplied outside the component. |
| [Everyday](everyday/) | Theme values and an opt-in browser presenter for explicitly provided guest frames. General display/input compatibility is a separate goal. |
| [Otter](otter/) | Command help and pinned package acquisition. |

Freestanding C components share the small [toolchain](toolchain/) directory.
Distribution-specific packaging, verification and native terminal attachment
belong to the distribution. This directory is not a package manager or runtime:
Sods and Muk can be used without constructing or installing a Ricebox root.

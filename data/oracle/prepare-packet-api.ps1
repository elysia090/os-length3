param([string]$Repository = (Join-Path $PSScriptRoot '../..'))
$taskRoot=[IO.Path]::GetFullPath($Repository)
$taskDirectory=Join-Path $taskRoot 'data/upstream/network-slirp'
New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
$taskHeader=Join-Path $taskDirectory 'libslirp.h'
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/qemu/libslirp/v4.9.3/src/libslirp.h' -OutFile $taskHeader
if((Get-FileHash -LiteralPath $taskHeader -Algorithm SHA256).Hash.ToLowerInvariant() -ne '2c95e3ae9780c1fdc9f6558f07d6d85a218c7f1342a0a36e44d653da37e41832'){throw 'official packet API identity mismatch'}
# The runtime-loaded DLL supplies its version. This build adapter does not
# claim a compile-time library release or enable conditional legacy APIs.
$taskVersion=@'
#ifndef LIBSLIRP_VERSION_H_
#define LIBSLIRP_VERSION_H_
#define SLIRP_MAJOR_VERSION 0
#define SLIRP_MINOR_VERSION 0
#define SLIRP_MICRO_VERSION 0
#define SLIRP_VERSION_STRING "runtime"
#define SLIRP_CHECK_VERSION(a,b,c) 0
#endif
'@
[IO.File]::WriteAllText((Join-Path $taskDirectory 'libslirp-version.h'),$taskVersion+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
Write-Output 'Official libslirp 4.9.3 public API verified; runtime DLL must be independently pinned.'

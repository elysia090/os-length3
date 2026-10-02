# Scope-local build tool; it is neither a release dependency nor a guest libc.
[CmdletBinding()]
param([string]$Output = 'temp/wasm-tools-34/vm.wasm')
$ErrorActionPreference = 'Stop'
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskTools = Join-Path $taskRepository 'temp/wasm-tools-34'
$taskArchive = Join-Path $taskTools 'sdk.tar.gz'
$taskSdk = Join-Path $taskTools 'wasi-sdk-34.0-x86_64-windows'
$taskDigest = 'cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f'
New-Item -ItemType Directory -Force -Path $taskTools | Out-Null
if (!(Test-Path -LiteralPath $taskArchive)) {
    Invoke-WebRequest 'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-windows.tar.gz' -OutFile $taskArchive
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskArchive).Hash.ToLowerInvariant() -ne $taskDigest) {
    throw 'Official SDK SHA-256 mismatch; refusing extraction/execution'
}
& tar -xzf $taskArchive -C $taskTools 'wasi-sdk-34.0-x86_64-windows/bin/clang.exe' 'wasi-sdk-34.0-x86_64-windows/bin/wasm-ld.exe' 'wasi-sdk-34.0-x86_64-windows/lib/clang/23/include'
if ($LASTEXITCODE) { throw 'SDK extraction failed' }
$taskOutput = [IO.Path]::GetFullPath((Join-Path $taskRepository $Output))
if (!$taskOutput.StartsWith($taskRepository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output must stay inside this repository'
}
New-Item -ItemType Directory -Force -Path (Split-Path $taskOutput) | Out-Null
Push-Location $taskRepository
try {
    & "$taskSdk/bin/clang.exe" --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib '-Wl,--no-entry,--strip-all,--export-table,--growable-table' -Xlinker '--import-memory=machine,memory' '-Wl,--export=vm_arena_min,--export=vm_open,--export=vm_close,--export=vm_bind_state,--export=vm_access,--export=vm_boot_prepare,--export=vm_boot_project,--export=vm_boot_initial_state,--export=vm_slot_min,--export=vm_bind_execution,--export=vm_run,--export=vm_completed,--export=vm_source_retired,--export=vm_boot_initial_segments,--export=vm_bind_segments,--export=vm_segment' -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion '-Isrc/v2/vm/include' '-Isrc/v2/support/include' '-Isrc/v2/machine-abi/include' 'src/v2/vm/wasm/entry.c' 'src/v2/vm/core/memory.c' 'src/v2/vm/core/mmu.c' 'src/v2/vm/core/boot.c' 'src/v2/vm/core/execution.c' 'src/v2/vm/core/segments.c' -o $taskOutput
    if ($LASTEXITCODE) { throw 'C VM Wasm build failed' }
} finally { Pop-Location }
Get-FileHash -Algorithm SHA256 -LiteralPath $taskOutput

# Scope-local build tool; it is neither a release dependency nor a guest libc.
[CmdletBinding()]
param([string]$Output = 'temp/wasm-tools-34/vm.wasm', [switch]$Compiler)
$ErrorActionPreference = 'Stop'
if ($Compiler -and !$PSBoundParameters.ContainsKey('Output')) {
    $Output = 'temp/wasm-tools-34/wasm-compiler.wasm'
}
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
  if ($Compiler) {
    $taskZydis = 'src/v2/x86/third_party/zydis'
    $taskSources = @(
      'src/v2/wasm-compiler/wasm/entry.c', 'src/v2/wasm-compiler/wasm/memory.c',
      'src/v2/wasm-compiler/src/read-optimized-x86.c', 'src/v2/wasm-compiler/src/lower-machine-abi.c',
      'src/v2/wasm-compiler/src/emit-function.c', 'src/v2/wasm-compiler/src/compile-cut.c',
      'src/v2/wasm-compiler/src/emit-cut.c', 'src/v2/wasm-compiler/src/lower-register.c',
      'src/v2/wasm-compiler/src/lower-shift.c',
      'src/v2/wasm-compiler/src/lower-memory.c', 'src/v2/wasm-compiler/src/lower-stack.c',
      'src/v2/wasm-compiler/src/lower-system.c', 'src/v2/x86/src/decode.c', 'src/v2/x86/src/elf.c',
      'src/v2/optimized-x86/src/proof.c', 'src/v2/optimized-x86/src/reader.c', 'src/v2/support/src/sha256.c'
    ) + @('Register', 'SharedData', 'DecoderData', 'Decoder', 'Mnemonic' | ForEach-Object { "$taskZydis/src/$_.c" })
    & "$taskSdk/bin/clang.exe" --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib '-Wl,--no-entry,--strip-all' -Xlinker '--import-memory=machine,memory' '-Wl,--export=compiler_arena_min,--export=compiler_report_bytes,--export=compiler_close,--export=compiler_open_elf,--export=compiler_open_pages,--export=compiler_emit' '-DZYAN_NO_LIBC' '-DZYDIS_STATIC_BUILD' '-DZYDIS_DISABLE_ENCODER' '-DZYDIS_DISABLE_FORMATTER' '-DZYDIS_DISABLE_SEGMENT' '-DZYDIS_DISABLE_KNC' '-Isrc/v2/wasm-compiler/include' '-Isrc/v2/optimized-x86/include' '-Isrc/v2/x86/include' '-Isrc/v2/support/include' '-Isrc/v2/machine-abi/include' "-I$taskZydis/include" "-I$taskZydis/dependencies/zycore/include" "-I$taskZydis/src" @taskSources -o $taskOutput
    if ($LASTEXITCODE) { throw 'C cold compiler Wasm build failed' }
  } else {
    $taskControl = @('-Wl,--export=vm_return,--export=vm_control,--export=vm_code', 'src/v2/vm/core/control.c', 'src/v2/vm/core/registers.c')
    & "$taskSdk/bin/clang.exe" --target=wasm32-unknown-unknown -O2 -ffreestanding -nostdlib '-Wl,--no-entry,--strip-all,--export-table,--growable-table' -Xlinker '--import-memory=machine,memory' '-Wl,--export=vm_arena_min,--export=vm_open,--export=vm_close,--export=vm_bind_state,--export=vm_access,--export=vm_boot_prepare,--export=vm_boot_project,--export=vm_boot_initial_state,--export=vm_slot_min,--export=vm_bind_execution,--export=vm_run,--export=vm_completed,--export=vm_source_retired,--export=vm_boot_initial_segments,--export=vm_bind_segments,--export=vm_segment' '-Wl,--export=vm_reserve,--export=vm_commit,--export=vm_abort,--export=vm_table' -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion '-Isrc/v2/vm/include' '-Isrc/v2/support/include' '-Isrc/v2/machine-abi/include' 'src/v2/vm/wasm/entry.c' 'src/v2/vm/core/memory.c' 'src/v2/vm/core/mmu.c' 'src/v2/vm/core/boot.c' 'src/v2/vm/core/execution.c' 'src/v2/vm/core/segments.c' 'src/v2/vm/core/tables.c' @taskControl -o $taskOutput
    if ($LASTEXITCODE) { throw 'C VM Wasm build failed' }
  }
} finally { Pop-Location }
Get-FileHash -Algorithm SHA256 -LiteralPath $taskOutput

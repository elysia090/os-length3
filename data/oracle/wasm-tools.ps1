# Scope-local build tool; it is neither a release dependency nor a guest libc.
[CmdletBinding()]
param([string]$Output = 'temp/wasm-tools-34/vm.wasm', [switch]$Compiler, [switch]$Profile,
    [int]$StaticMin = 131072)
$ErrorActionPreference = 'Stop'
if ($Profile -and $Compiler) { throw 'Source profiling belongs to the VM, not the compiler' }
if ($StaticMin -lt 65536 -or $StaticMin -gt 2097152 -or ($StaticMin % 65536) -ne 0 -or
    (!$Compiler -and $PSBoundParameters.ContainsKey('StaticMin'))) {
    throw 'StaticMin is an explicit compiler-only 64KiB-aligned private memory reservation'
}
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
# The product Makefiles are the only build/source/ABI definition. This helper
# locates the pinned toolchain; it must not retain a second linker invocation.
$taskMake = Get-Command make -ErrorAction Stop
$taskProduct = if ($Compiler) { 'wasm-compiler' } else { 'vm' }
$taskCompiler = (Join-Path $taskSdk 'bin/clang.exe').Replace('\', '/')
$taskTarget = $taskOutput.Replace('\', '/')
Push-Location $taskRepository
try {
    $taskProfile = if ($Profile) { '1' } else { '0' }
    # Mode flags are not ordinary timestamp dependencies. Rebuild this small
    # standalone module so changing profile mode cannot retain a stale target.
    $taskLayout = if ($Compiler) { @("COLD_STATIC_MIN=$StaticMin") } else { @() }
    & $taskMake.Source -B -C "src/v2/$taskProduct" wasm "WASM_CC=$taskCompiler" "WASM_OUTPUT=$taskTarget" "WASM_PROFILE=$taskProfile" @taskLayout
    if ($LASTEXITCODE) { throw "C $taskProduct Wasm build failed" }
} finally { Pop-Location }
Get-FileHash -Algorithm SHA256 -LiteralPath $taskOutput

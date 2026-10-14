param([string]$Compiler)
$ErrorActionPreference='Stop'
if (!$Compiler -or !(Test-Path -LiteralPath $Compiler)) { throw 'Existing Wasm clang path required' }
$repositoryPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sourcePath=Join-Path $repositoryPath 'src/v2/web/source-demands.c'
$outputPath=Join-Path $repositoryPath 'src/v2/web/source-demands.wasm'
& $Compiler --target=wasm32-unknown-unknown -O2 -ffreestanding -fno-builtin -nostdlib `
 '-Wl,--no-entry,--export-memory,--initial-memory=65536,--max-memory=65536,-z,stack-size=4096' `
 '-Wl,--export=source_demands_abi,--export=source_demands_read,--export=source_demands_data,--export=source_demands_reset,--export=source_demands_observations,--export=source_demands_reused' `
 $sourcePath -o $outputPath
if ($LASTEXITCODE) { throw 'Metadata observer build failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath | Select-Object Path,Hash

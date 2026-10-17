# Independent oracles only. Official source stays under data; build objects
# and executables are Windows temp products, never distribution artifacts.
[CmdletBinding()]
param([switch]$Verify,[switch]$Arithmetic)
$ErrorActionPreference='Stop'
$taskRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskInputs=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'float-source.json') -Raw | ConvertFrom-Json
Push-Location $taskRepo
try {
    foreach($kind in @('softfloat','testfloat')) {
        $inputRow=$taskInputs.$kind
        $archive=Join-Path $taskRepo $inputRow.archive
        New-Item -ItemType Directory -Force -Path (Split-Path $archive) | Out-Null
        if(!(Test-Path -LiteralPath $archive)){Invoke-WebRequest $inputRow.url -OutFile $archive}
        if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputRow.sha256){throw "$kind archive pin mismatch"}
        $sourceName=if($kind -eq 'softfloat'){'SoftFloat-3e'}else{'TestFloat-3e'}
        $sourceRoot=Join-Path (Split-Path $archive) $sourceName
        if(!(Test-Path -LiteralPath (Join-Path $sourceRoot 'source'))){Expand-Archive -LiteralPath $archive -DestinationPath (Split-Path $archive)}
        $build=Join-Path $taskRepo "temp/float-oracle/$kind-build"
        New-Item -ItemType Directory -Force -Path $build | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'build/Win64-MinGW-w64/Makefile'),(Join-Path $sourceRoot 'build/Win64-MinGW-w64/platform.h') -Destination $build
        $sourceDir=($sourceRoot.Replace('\','/')+'/source')
        if($kind -eq 'softfloat'){
            & make -j4 -C $build "SOURCE_DIR=$sourceDir" 'COMPILE_C=gcc -c -Werror-implicit-function-declaration -DSOFTFLOAT_FAST_INT64 $(SOFTFLOAT_OPTS) $(C_INCLUDES) -O2 -o $@' 'MAKELIB=ar crs $@'
        }else{
            $softDir=(Join-Path $taskRepo 'distribution/upstream/softfloat/3e/SoftFloat-3e').Replace('\','/')
            $softLibrary=(Join-Path $taskRepo 'temp/float-oracle/softfloat-build/softfloat.a').Replace('\','/')
            & make -j4 -C $build testfloat_gen.exe testsoftfloat.exe "SOURCE_DIR=$sourceDir" "SOFTFLOAT_DIR=$softDir" "SOFTFLOAT_LIB=$softLibrary" 'COMPILE_C=gcc -std=c99 -c -Werror-implicit-function-declaration $(TESTFLOAT_OPTS) $(C_INCLUDES) -O2 -o $@' 'COMPILE_SLOWFLOAT_C=gcc -std=c99 -c -Werror-implicit-function-declaration $(TESTFLOAT_OPTS) $(C_INCLUDES) -O3 -o $@' 'MAKELIB=ar crs $@' 'LINK=gcc -o $@'
        }
        if($LASTEXITCODE){throw "$kind oracle build failed"}
    }
    if($Verify){
        $test=Join-Path $taskRepo 'temp/float-oracle/testfloat-build/testsoftfloat.exe'
        & $test -level 1 i64_to_extF80
        if($LASTEXITCODE){throw 'integer oracle self-check failed'}
        & $test -level 1 -precision80 -rnear_even extF80_add
        if($LASTEXITCODE){throw 'ext80 add oracle self-check failed'}
    }
    if($Arithmetic){
        $test=Join-Path $taskRepo 'temp/float-oracle/testfloat-build/testsoftfloat.exe'
        foreach($precision in @('32','64','80')){
            foreach($rounding in @('rnear_even','rmin','rmax','rminMag')){
                foreach($operation in @('extF80_add','extF80_sub')){
                    & $test -level 1 "-precision$precision" "-$rounding" -tininessafter $operation
                    if($LASTEXITCODE){throw "arithmetic oracle self-check failed: $precision / $rounding / $operation"}
                }
            }
        }
    }
}finally{Pop-Location}

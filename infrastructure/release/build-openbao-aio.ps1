[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [string]$GoArchive,
  [string]$OpenBaoArchive,
  [string]$GoModuleCache
)

$ErrorActionPreference = 'Stop'
$profile = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'openbao-aio.json') | ConvertFrom-Json
$commit = $profile.upstreamCommit
$goSha = '178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e'
$sourceSha = '66e11aed1b4911c7da20ee93283db7eac08e15a7617bc73fb33d70505c1913d5'
$binarySha = $profile.binarySha256
$patchSha = $profile.patchSha256

if (Test-Path -LiteralPath $OutputDirectory) {
  throw 'Choose a new evaluation directory.'
}
if ($GoArchive) { $GoArchive = (Resolve-Path -LiteralPath $GoArchive).Path }
if ($OpenBaoArchive) { $OpenBaoArchive = (Resolve-Path -LiteralPath $OpenBaoArchive).Path }
if ($GoModuleCache) { $GoModuleCache = (Resolve-Path -LiteralPath $GoModuleCache).Path }
$directory = (New-Item -ItemType Directory -Path $OutputDirectory).FullName
$patch = Join-Path $PSScriptRoot 'openbao-aio.patch'

function Assert-Digest([string]$File, [string]$Expected) {
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) {
    throw "SHA-256 does not match for $(Split-Path -Leaf $File)."
  }
}

Assert-Digest $patch $patchSha
if (!$GoArchive) {
  $GoArchive = Join-Path $directory 'go1.27.4.windows-amd64.zip'
  Invoke-WebRequest -Uri 'https://go.dev/dl/go1.27.4.windows-amd64.zip' -OutFile $GoArchive
}
if (!$OpenBaoArchive) {
  $OpenBaoArchive = Join-Path $directory 'openbao.tar.gz'
  Invoke-WebRequest -Uri "https://codeload.github.com/openbao/openbao/tar.gz/$commit" -OutFile $OpenBaoArchive
}
Assert-Digest $GoArchive $goSha
Assert-Digest $OpenBaoArchive $sourceSha

tar -xf $GoArchive -C $directory
if ($LASTEXITCODE) { throw 'Go extraction failed.' }
tar -xf $OpenBaoArchive -C $directory
if ($LASTEXITCODE) { throw 'OpenBao extraction failed.' }
$source = Join-Path $directory "openbao-$commit"
$go = Join-Path $directory 'go/bin/go.exe'
$env:GOTOOLCHAIN = 'local'
$env:GOCACHE = Join-Path $directory 'go-build-cache'
$env:GOMODCACHE = if ($GoModuleCache) { $GoModuleCache } else { Join-Path $directory 'go-module-cache' }
$env:GOWORK = 'off'
$env:GOFLAGS = '-buildvcs=false'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:GOAMD64 = 'v1'
$env:CGO_ENABLED = '0'
$env:GOPROXY = 'https://proxy.golang.org'
$env:GOSUMDB = 'sum.golang.org'
$env:GOPRIVATE = ''
$env:GONOPROXY = ''
$env:GONOSUMDB = ''
$env:GOINSECURE = ''

Push-Location -LiteralPath $source
try {
  git -c core.autocrlf=false apply --check $patch
  if ($LASTEXITCODE) { throw 'OpenBao AIO patch does not match the pinned source.' }
  git -c core.autocrlf=false apply $patch
  if ($LASTEXITCODE) { throw 'Applying the OpenBao AIO patch failed.' }
  $exe = Join-Path $directory 'bao.exe'
  $repeat = Join-Path $directory 'bao-repeat.exe'
  foreach ($file in @($exe, $repeat)) {
    & $go build -mod=readonly -trimpath -o $file .
    if ($LASTEXITCODE) { throw 'OpenBao AIO build failed.' }
    Assert-Digest $file $binarySha
  }
  $metadata = & $go version -m $exe
  if ($LASTEXITCODE -or $metadata -match 'go-jose/go-jose/v3') {
    throw 'Unexpected Go module metadata in the OpenBao AIO binary.'
  }
  [ordered]@{
    status = 'pass'
    sourceCommit = $commit
    sourceArchiveSha256 = $sourceSha
    patchSha256 = $patchSha
    goToolchainSha256 = $goSha
    binarySha256 = $binarySha
    repeatMatched = $true
    checkedAtVietnam = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(7)).ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'build-receipt.json') -Encoding utf8
} finally {
  Pop-Location
}

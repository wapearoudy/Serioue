# Produce the two genuine signatures the accept-path test serves.
#
#   pwsh -NoProfile -File scripts/sign-probe.ps1
#
# Both files hold identical bytes. They differ only in whether the signature is
# bound to a version, because `tauri signer sign` warns about exactly that and
# the honest way to answer "does it need --app-version?" is to try both rather
# than to guess.
#
#   probe.bin   signed without --app-version
#               trusted comment: timestamp:…	file:probe.bin
#   probev.bin  signed with --app-version 0.1.3
#               trusted comment: timestamp:…	file:probev.bin	version:0.1.3
#
# Note the environment variable takes the *contents* of the key, not its path.
# Passing a path fails with:
#   failed to decode base64 secret key: Invalid symbol 58, offset 1
# where 58 is the position of the ":" in "C:\...".

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root "test-results\signaccept"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$keyPath = Join-Path $root "src-tauri\serious-updater.key"
if (-not (Test-Path $keyPath)) { throw "no signing key at $keyPath" }

$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

$payload = "serious updater acceptance probe - not an executable`n"
foreach ($name in @("probe.bin", "probev.bin")) {
    [System.IO.File]::WriteAllText((Join-Path $dir $name), $payload)
    $sig = Join-Path $dir "$name.sig"
    if (Test-Path $sig) { Remove-Item $sig }
}

Push-Location $root
try {
    Write-Host "== signing without --app-version =="
    pnpm tauri signer sign "test-results\signaccept\probe.bin"
    if ($LASTEXITCODE -ne 0) { throw "signing probe.bin failed ($LASTEXITCODE)" }

    Write-Host "== signing with --app-version 0.1.3 =="
    pnpm tauri signer sign --app-version 0.1.3 "test-results\signaccept\probev.bin"
    if ($LASTEXITCODE -ne 0) { throw "signing probev.bin failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

foreach ($name in @("probe.bin", "probev.bin")) {
    $p = Join-Path $dir $name
    $s = "$p.sig"
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Content $s -Raw).Trim()))
    $trusted = ($decoded -split "`r?`n") | Where-Object { $_ -like "trusted comment:*" }
    "{0,-12} payload {1} bytes · sig {2} bytes" -f $name, (Get-Item $p).Length, (Get-Item $s).Length
    "             $trusted"
}

"remove the signing material from this shell when you are done:"
"  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
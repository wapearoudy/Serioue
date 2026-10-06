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
#   probev.bin  signed with the derived next version
#               trusted comment: timestamp:…	file:probev.bin	version:<patch+1>
#
# The version is derived from src-tauri/tauri.conf.json; set
# SERIOUS_FAKE_UPDATE_VERSION to override it without touching any tracked file.
# That name is shared with update-channel-test.mjs and
# update-signature-accept-test.mjs, which serve the version this probe is signed
# for — the accept test reads the binding back out of probev.bin.sig and refuses
# to run if the two disagree.
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

# The version comes from the one place that defines it, never typed here: a
# pinned version goes stale at the next release and the signature would claim a
# version the manifest no longer says.
#
# SERIOUS_FAKE_UPDATE_VERSION is the SAME variable the Node legs read, and it means
# the same thing on both sides: the version the fake update channel serves. This
# script signs the bound probe for exactly that version, so "signed for V" and
# "served as V" cannot drift apart.
#
# It replaces SERIOUS_FAKE_VERSION, which meant "pretend the app is V" and signed
# V+1 — one word of difference and the opposite arithmetic, which is exactly how a
# fixture goes quietly stale. Setting the old name is an error, not a shrug.
$conf = Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$appVersion = $conf.version
$parts = $appVersion.Split(".")
$servedVersion = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
if ($env:SERIOUS_FAKE_UPDATE_VERSION) {
    $servedVersion = $env:SERIOUS_FAKE_UPDATE_VERSION
}
if ($env:SERIOUS_FAKE_VERSION) {
    $retired = $env:SERIOUS_FAKE_VERSION
    $rp = $retired.Split(".")
    $hint = ""
    if ($rp.Count -eq 3 -and $rp[2] -match '^\d+$') {
        $hint = " For the old SERIOUS_FAKE_VERSION=$retired that means SERIOUS_FAKE_UPDATE_VERSION=$($rp[0]).$($rp[1]).$([int]$rp[2] + 1)."
    }
    throw ("SERIOUS_FAKE_VERSION has been retired: it overrode the APP version and signed the probe as +1, " +
        "while SERIOUS_FAKE_UPDATE_VERSION overrides the SERVED version on both this script and the Node legs." +
        $hint)
}
Write-Host "app version $appVersion -> signing the bound probe as $servedVersion (the version the fake channel serves)"

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

    Write-Host "== signing with --app-version $servedVersion =="
    pnpm tauri signer sign --app-version $servedVersion "test-results\signaccept\probev.bin"
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
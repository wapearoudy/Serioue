# Trust the certificate already written by make-local-cert.ps1, without
# regenerating it.
#
#   pwsh -NoProfile -File scripts/trust-local-cert.ps1
#
# Kept separate from generation on purpose: generating writes new key material and
# then adding it to the store is two operations, and the store one is the one that
# occasionally hangs. Splitting them means a hung add does not also invalidate the
# certificate on disk — which is exactly what happened when both ran together.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$certPath = Join-Path $root "test-results\local-cert\cert.pem"
if (-not (Test-Path $certPath)) { throw "no $certPath — run scripts/make-local-cert.ps1 first" }

$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "CurrentUser")
try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($cert)
} finally {
    $store.Close()
}

$check = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "CurrentUser")
try {
    $check.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $present = @($check.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint })
} finally {
    $check.Close()
}
if (-not $present) { throw "still not trusted after adding" }
"trusted $($cert.Thumbprint)"
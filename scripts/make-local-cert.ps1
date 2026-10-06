# Makes a self-signed certificate for 127.0.0.1 and trusts it for the current
# user only.
#
#   powershell -File scripts/make-local-cert.ps1
#
# The Tauri updater plugin refuses to start on a plain http:// endpoint
# ("The configured updater endpoint must use a secure protocol like https"),
# and the update channel we are trying to exercise is a local loopback server.
# So the channel has to speak TLS, and the certificate has to be one the client
# trusts.
#
# Installing into the *user* store (certutil -user) needs no administrator
# rights and does not touch the machine store. Schannel — which reqwest uses on
# Windows — reads the user root store, so the app will accept it.
#
# Writes to test-results/local-cert/: cert.pem, key.pem.

$ErrorActionPreference = "Stop"
$out = Join-Path (Split-Path $PSScriptRoot -Parent) "test-results\local-cert"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=127.0.0.1",
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

# A bare CN is not enough: the client verifies the SAN. X509SubjectAlternative-
# NameBuilder is not resolvable in every host runtime, so the extension is
# written as DER directly:
#   SEQUENCE { [2] 7F000001, [2] "localhost" }
#   30 11 82 04 7F 00 00 01 82 09 "localhost"
$localhost = [System.Text.Encoding]::ASCII.GetBytes("localhost")
$sanDer = [byte[]]@(0x30, 0x11, 0x82, 0x04, 0x7F, 0x00, 0x00, 0x01, 0x82, 0x09) + $localhost
$req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509Extension]::new("2.5.29.17", $sanDer, $false)
)

# Mark it as a CA so it may be trusted directly as a root, and state the uses.
$req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$eku = [System.Security.Cryptography.OidCollection]::new()
$null = $eku.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")) # serverAuth
$req.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false)
)

$notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
$notAfter = [DateTimeOffset]::UtcNow.AddYears(2)
$cert = $req.CreateSelfSigned($notBefore, $notAfter)

$certPath = Join-Path $out "cert.pem"
$keyPath = Join-Path $out "key.pem"
[System.IO.File]::WriteAllText($certPath, $cert.ExportCertificatePem(), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($keyPath, $rsa.ExportPkcs8PrivateKeyPem(), [System.Text.UTF8Encoding]::new($false))

# Trust it for this user only. The X509Store API is used rather than
# `certutil -addstore` because certutil rejects the exported PFX with
# CRYPT_E_NO_MATCH and says nothing useful about why.
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
    $present = $check.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
} finally {
    $check.Close()
}

if (-not $present) { throw "certificate was not added to the user ROOT store" }

"subject : $($cert.Subject)"
"thumb   : $($cert.Thumbprint)"
"san     : $($req.CertificateExtensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($true) })"
"expires : $($cert.NotAfter)"
"cert    : $certPath"
"key     : $keyPath"
"trusted : user ROOT store (no admin required)"
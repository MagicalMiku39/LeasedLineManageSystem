param(
  [string]$DnsName = "localhost",
  [string]$OutputDir = "certs",
  [int]$Years = 3,
  [string]$PfxPassphrase = "changeit"
)

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$subject = "CN=$DnsName"
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  $subject,
  $rsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$sanBuilder.AddDnsName($DnsName)
if ($DnsName -ne "localhost") {
  $sanBuilder.AddDnsName("localhost")
}
$request.CertificateExtensions.Add($sanBuilder.Build())
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
    $true
  )
)

$certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddYears($Years))
$certPem = "-----BEGIN CERTIFICATE-----`n" +
  [Convert]::ToBase64String($certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert), [Base64FormattingOptions]::InsertLineBreaks) +
  "`n-----END CERTIFICATE-----`n"

Set-Content -LiteralPath (Join-Path $OutputDir "server.crt") -Value $certPem -Encoding ascii

$pfxPath = Join-Path $OutputDir "server.pfx"
$pfxBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $PfxPassphrase)
[System.IO.File]::WriteAllBytes((Resolve-Path $OutputDir).Path + [System.IO.Path]::DirectorySeparatorChar + "server.pfx", $pfxBytes)

try {
  $keyPem = "-----BEGIN PRIVATE KEY-----`n" +
    [Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey(), [Base64FormattingOptions]::InsertLineBreaks) +
    "`n-----END PRIVATE KEY-----`n"
  Set-Content -LiteralPath (Join-Path $OutputDir "server.key") -Value $keyPem -Encoding ascii
} catch {
  Write-Host "PEM private key export is not available in this PowerShell runtime; generated PFX instead."
}

Write-Host "Generated:"
Write-Host (Join-Path $OutputDir "server.crt")
Write-Host $pfxPath

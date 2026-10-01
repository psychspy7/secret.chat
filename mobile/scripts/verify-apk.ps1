param([string]$Apk = 'release/SecretChat-1.5.0.apk')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$apkPath = [IO.Path]::GetFullPath((Join-Path $workspace $Apk))
$env:JAVA_HOME = Join-Path $workspace '.android-tools/jdk'
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
$buildTools = Join-Path $workspace '.android-tools/sdk/build-tools/36.0.0'
& (Join-Path $buildTools 'apksigner.bat') verify --verbose --print-certs $apkPath
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
$metadata = & (Join-Path $buildTools 'aapt.exe') dump badging $apkPath
if ($LASTEXITCODE -ne 0) { throw 'APK metadata could not be inspected.' }
if (-not ($metadata -match "package: name='com.kittycorp.sidechat'")) { throw 'Unexpected Android package.' }
if (-not ($metadata -match "application-label:'SecretChat'")) { throw 'Incorrect visible app name.' }
if ($metadata -match 'application-debuggable') { throw 'Release APK must not be debuggable.' }
$metadata | Select-String "^package:|^sdkVersion:|^targetSdkVersion:|^application-label:"

# Known private credentials are held only in memory for comparison.
$known = [Collections.Generic.List[string]]::new()
foreach ($file in @('.mobile-secrets/fcm-service-account.json', '.mobile-secrets/google-oauth.json')) {
    $path = Join-Path $workspace $file
    if (Test-Path -LiteralPath $path) {
        $value = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
        foreach ($field in $value.PSObject.Properties) {
            if ($field.Name -match 'secret|private.?key|password' -and $field.Value -is [string] -and $field.Value.Length -gt 12) {
                $known.Add($field.Value)
            }
        }
    }
}
$signingPath = Join-Path $workspace '.android-signing/keystore.properties'
if (Test-Path -LiteralPath $signingPath) {
    foreach ($line in [IO.File]::ReadAllLines($signingPath)) {
        if ($line -match '^(?:storePassword|keyPassword)=(.+)$') { $known.Add($Matches[1]) }
    }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($apkPath)
try {
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -match '(^|/)(\.env(?:\..*)?|keystore\.properties|[^/]*service-account[^/]*\.json)$|\.(p12|jks|keystore|pem)$') { throw 'Private configuration file found in APK.' }
        $stream = $entry.Open()
        $memory = [IO.MemoryStream]::new()
        try {
            $stream.CopyTo($memory)
            $text = [Text.Encoding]::UTF8.GetString($memory.ToArray())
            if ($text -match '-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{20,}') { throw 'Private credential pattern found in APK.' }
            foreach ($secret in $known) { if ($text.Contains($secret)) { throw 'Known private credential found in APK.' } }
        } finally { $memory.Dispose(); $stream.Dispose() }
    }
} finally { $archive.Dispose() }
Write-Output 'APK signature, SecretChat label, package identity, release mode, and private-credential scan passed.'
Get-FileHash -LiteralPath $apkPath -Algorithm SHA256 | Format-List

param(
    [string]$Name = 'SecretChat-Android-Source-2026-10-01.zip',
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$releaseDirectory = [IO.Path]::GetFullPath((Join-Path $workspace 'release'))
if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$') { throw 'Use a simple ZIP filename without directories.' }
$destination = [IO.Path]::GetFullPath((Join-Path $releaseDirectory $Name))
if (-not $destination.StartsWith($releaseDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive destination must stay inside release/.' }

# Git supplies the initial allowlist. These explicit exclusions also protect
# against a secret or build directory being accidentally tracked in the future.
$forbiddenPath = '(?i)(^|/)(\.git|\.agents|\.codex|\.mobile-secrets|\.android-signing|\.android-tools|\.firebase|\.vercel(?!ignore$)[^/]*|\.npm-cache|\.gradle[^/]*|\.release-tools|node_modules|dist|build|release|test-results|playwright-report|capacitor-cordova-android-plugins)(/|$)|^supabase/\.temp/|^mobile/android/app/src/main/assets/|(^|/)(google-services\.json|[^/]*service-account[^/]*\.json|keystore\.properties|local\.properties|\.bootstrap\.json|\.host-credentials\.txt)$|\.(apk|aab|jks|keystore|p12|pfx|pem|key|log|zip|hprof|heapdump)$'
$allowedRoots = @('.github/', 'src/', 'public/', 'supabase/', 'tests/', 'mobile/')
$allowedRootFiles = @('.env.example', '.gitignore', '.vercelignore', 'README.md', 'UPDATES.md', 'firebase.json', 'index.html', 'netlify.toml', 'package-lock.json', 'package.json', 'vercel.json')

$gitProcess = [Diagnostics.Process]::new()
$gitProcess.StartInfo.FileName = 'git'
$gitProcess.StartInfo.WorkingDirectory = $workspace
$gitProcess.StartInfo.UseShellExecute = $false
$gitProcess.StartInfo.RedirectStandardOutput = $true
$gitProcess.StartInfo.RedirectStandardError = $true
foreach ($argument in @('ls-files', '-z', '--cached', '--others', '--exclude-standard')) { $gitProcess.StartInfo.ArgumentList.Add($argument) }
if (-not $gitProcess.Start()) { throw 'Could not read the Git source allowlist.' }
$gitOutput = $gitProcess.StandardOutput.ReadToEnd()
$gitError = $gitProcess.StandardError.ReadToEnd()
$gitProcess.WaitForExit()
if ($gitProcess.ExitCode -ne 0) { throw 'Could not read the Git source allowlist.' }
$candidates = @($gitOutput.Split([char]0, [StringSplitOptions]::RemoveEmptyEntries) | Sort-Object -Unique)
$files = @($candidates | Where-Object {
    $relative = $_.Replace('\', '/')
    $rootAllowed = $relative -in $allowedRootFiles
    foreach ($prefix in $allowedRoots) { if ($relative.StartsWith($prefix, [StringComparison]::Ordinal)) { $rootAllowed = $true } }
    $environmentFile = ($relative -match '(^|/)\.env($|\.)') -and ($relative -notmatch '(^|/)\.env\.example$')
    $rootAllowed -and ($relative -notmatch $forbiddenPath) -and -not $environmentFile
})
if ($files.Count -eq 0) { throw 'The source allowlist is empty.' }
foreach ($required in @('.vercelignore', 'mobile/package.json', 'mobile/src/main.js', 'mobile/android/gradle/wrapper/gradle-wrapper.jar', 'src/main.js', 'supabase/migrations/20260930041856_mobile_private_android.sql')) {
    if ($required -notin $files) { throw "Required source file is missing from the allowlist: $required" }
}

# Read known local secrets into memory only. Never print their contents or place
# them in a manifest. Both plaintext and JSON-escaped forms are checked.
$secretValues = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
function Add-KnownSecret([object]$Value) {
    if ($null -eq $Value -or $Value -isnot [string] -or $Value.Length -lt 8) { return }
    [void]$secretValues.Add($Value)
    $escaped = ConvertTo-Json -InputObject $Value -Compress
    if ($escaped.Length -gt 2) { [void]$secretValues.Add($escaped.Substring(1, $escaped.Length - 2)) }
}
function Add-PrivateJsonFields([object]$Object) {
    if ($null -eq $Object) { return }
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in $Object.Keys) {
            if ([string]$key -match '(?i)secret|password|private.?key|access.?token|refresh.?token') { Add-KnownSecret $Object[$key] }
            else { Add-PrivateJsonFields $Object[$key] }
        }
    } elseif ($Object -is [pscustomobject]) {
        foreach ($property in $Object.PSObject.Properties) {
            if ($property.Name -match '(?i)secret|password|private.?key|access.?token|refresh.?token') { Add-KnownSecret $property.Value }
            else { Add-PrivateJsonFields $property.Value }
        }
    } elseif ($Object -is [System.Collections.IEnumerable] -and $Object -isnot [string]) {
        foreach ($value in $Object) { Add-PrivateJsonFields $value }
    }
}
$secretsDirectory = Join-Path $workspace '.mobile-secrets'
if (Test-Path -LiteralPath $secretsDirectory) {
    foreach ($secretFile in Get-ChildItem -LiteralPath $secretsDirectory -File) {
        $secretText = [IO.File]::ReadAllText($secretFile.FullName)
        if ($secretFile.Extension -eq '.json') { Add-PrivateJsonFields (ConvertFrom-Json -InputObject $secretText) }
        elseif ($secretFile.Extension -eq '.env') {
            foreach ($line in $secretText -split '\r?\n') {
                if ($line -match '^[A-Z_][A-Z0-9_]*=(.+)$') {
                    $value = $Matches[1]
                    try { Add-PrivateJsonFields (ConvertFrom-Json -InputObject $value) } catch { Add-KnownSecret $value }
                }
            }
        }
    }
}
$signingProperties = Join-Path $workspace '.android-signing/keystore.properties'
if (Test-Path -LiteralPath $signingProperties) {
    foreach ($line in [IO.File]::ReadAllLines($signingProperties)) {
        if ($line -match '^(?:storePassword|keyPassword)=(.+)$') { Add-KnownSecret $Matches[1] }
    }
}
function Assert-CleanContent([byte[]]$Bytes, [string]$RelativePath) {
    $text = [Text.Encoding]::UTF8.GetString($Bytes)
    if ($text -match '-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{80,}') { throw "Private key material detected in $RelativePath" }
    if ($text -match 'GOCSPX-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|sbp_[a-f0-9]{30,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}') { throw "Credential-shaped material detected in $RelativePath" }
    foreach ($secret in $secretValues) { if ($text.Contains($secret, [StringComparison]::Ordinal)) { throw "Known local secret detected in $RelativePath" } }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporary = [IO.Path]::GetFullPath((Join-Path $releaseDirectory ($Name + '.pending')))
$archive = $null
$stream = $null
try {
    if (-not $CheckOnly) {
        New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    }
    foreach ($relative in $files) {
        $normalized = $relative.Replace('\', '/')
        $fullPath = [IO.Path]::GetFullPath((Join-Path $workspace $normalized))
        if (-not $fullPath.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'A source path escaped the workspace.' }
        $item = Get-Item -LiteralPath $fullPath
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $target = $item.ResolveLinkTarget($true)
            if ($null -ne $target -and -not $target.FullName.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Source link points outside the workspace: $relative" }
        }
        $bytes = [IO.File]::ReadAllBytes($fullPath)
        Assert-CleanContent $bytes $normalized
        if ($archive) {
            $entry = $archive.CreateEntry($normalized, [IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try { $entryStream.Write($bytes, 0, $bytes.Length) } finally { $entryStream.Dispose() }
        }
    }
    if ($CheckOnly) { Write-Output "Source scan passed: $($files.Count) allowlisted files; known local credentials and private key material absent."; return }
    $archive.Dispose(); $archive = $null
    $stream.Dispose(); $stream = $null

    # Read the completed archive back and verify names, required files, and its
    # actual entry bytes rather than trusting the source-side check alone.
    $verification = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        if ($verification.Entries.Count -ne $files.Count) { throw 'The ZIP entry count does not match the source allowlist.' }
        foreach ($entry in $verification.Entries) {
            if ($entry.FullName -notin $files -or $entry.FullName -match $forbiddenPath) { throw 'Unexpected file in source archive.' }
            $entryStream = $entry.Open()
            $memory = [IO.MemoryStream]::new()
            try { $entryStream.CopyTo($memory); Assert-CleanContent $memory.ToArray() $entry.FullName }
            finally { $memory.Dispose(); $entryStream.Dispose() }
        }
    } finally { $verification.Dispose() }
    Move-Item -LiteralPath $temporary -Destination $destination -Force
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    [pscustomobject]@{ Path = $destination; Files = $files.Count; Bytes = (Get-Item -LiteralPath $destination).Length; SHA256 = $hash; SecretScan = 'Passed: archive contents checked against local credentials and private key patterns' } | Format-List
} finally {
    if ($archive) { $archive.Dispose() }
    if ($stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

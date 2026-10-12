param([switch]$SkipWebBuild)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$mobileDir = Join-Path $workspace 'mobile'
$toolsDir = Join-Path $workspace '.android-tools'
$env:JAVA_HOME = Join-Path $toolsDir 'jdk'
$env:ANDROID_HOME = Join-Path $toolsDir 'sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = Join-Path $toolsDir 'user'
$env:GRADLE_USER_HOME = Join-Path $toolsDir 'gradle-cache'
$env:PATH = "$env:JAVA_HOME/bin;$env:ANDROID_HOME/platform-tools;$env:PATH"
if (-not (Test-Path "$env:JAVA_HOME/bin/keytool.exe")) { throw 'Run native-setup.ps1 first.' }

$signingDir = Join-Path $workspace '.android-signing'
$signingProperties = Join-Path $signingDir 'keystore.properties'
$keyStore = Join-Path $signingDir 'sidechat-release.p12'
if (-not (Test-Path -LiteralPath $signingProperties) -or -not (Test-Path -LiteralPath $keyStore)) {
    throw 'Restore the original .android-signing key and properties before building an update. A replacement key cannot update existing installations.'
}
Push-Location $mobileDir
try {
    if (-not $SkipWebBuild) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Mobile web build failed.' }
    }
    & node ./scripts/native-audio.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Notification sound generation failed.' }
    & npx.cmd cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Native sync failed.' }
    Push-Location android
    try {
        & ./gradlew.bat --no-daemon :app:assembleRelease :app:bundleRelease :app:testReleaseUnitTest
        if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
    } finally { Pop-Location }
    $apk = Join-Path $mobileDir 'android/app/build/outputs/apk/release/app-release.apk'
    $bundle = Join-Path $mobileDir 'android/app/build/outputs/bundle/release/app-release.aab'
    $gradleConfig = Get-Content -LiteralPath (Join-Path $mobileDir 'android/app/build.gradle') -Raw
    if ($gradleConfig -notmatch 'versionName\s+"([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)"') { throw 'Cannot identify release versionName.' }
    $releaseVersion = $Matches[1]
    $destination = Join-Path $workspace "release/SecretChat-$releaseVersion.apk"
    $bundleDestination = Join-Path $workspace "release/SecretChat-$releaseVersion.aab"
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $apk -Destination $destination -Force
    Copy-Item -LiteralPath $bundle -Destination $bundleDestination -Force
    & "$env:ANDROID_HOME/build-tools/36.0.0/apksigner.bat" verify --verbose --print-certs $destination
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    & "$env:JAVA_HOME/bin/jarsigner.exe" -verify $bundleDestination
    if ($LASTEXITCODE -ne 0) { throw 'AAB signature verification failed.' }
    Get-FileHash -LiteralPath $destination, $bundleDestination -Algorithm SHA256 | Format-List
} finally { Pop-Location }

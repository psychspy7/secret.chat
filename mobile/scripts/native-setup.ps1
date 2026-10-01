$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$toolsDir = Join-Path $workspace '.android-tools'
$sdkDir = Join-Path $toolsDir 'sdk'
New-Item -ItemType Directory -Force -Path $toolsDir, $sdkDir | Out-Null
$ProgressPreference = 'SilentlyContinue'

if (-not (Test-Path (Join-Path $toolsDir 'jdk/bin/java.exe'))) {
    $metadata = Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
    $package = $metadata[0].binary.package
    $jdkZip = Join-Path $toolsDir 'jdk.zip'
    Invoke-WebRequest $package.link -OutFile $jdkZip
    if ((Get-FileHash $jdkZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.checksum) { throw 'Java download checksum mismatch.' }
    $jdkStage = Join-Path $toolsDir 'jdk-unpack'
    Expand-Archive -LiteralPath $jdkZip -DestinationPath $jdkStage -Force
    $jdkSource = Get-ChildItem -LiteralPath $jdkStage -Directory | Select-Object -First 1
    Move-Item -LiteralPath $jdkSource.FullName -Destination (Join-Path $toolsDir 'jdk')
}
if (-not (Test-Path (Join-Path $sdkDir 'cmdline-tools/latest/bin/sdkmanager.bat'))) {
    [xml]$repository = (Invoke-WebRequest 'https://dl.google.com/android/repository/repository2-1.xml').Content
    $package = $repository.SelectNodes('//*[local-name()="remotePackage"]') | Where-Object { $_.path -eq 'cmdline-tools;latest' } | Select-Object -First 1
    $archive = $package.archives.archive | Where-Object { $_.'host-os' -eq 'windows' } | Select-Object -First 1
    $sdkZip = Join-Path $toolsDir 'commandline-tools.zip'
    if (-not (Test-Path $sdkZip)) { Invoke-WebRequest ('https://dl.google.com/android/repository/' + $archive.complete.url) -OutFile $sdkZip }
    $expectedHash = [string]$archive.complete.checksum
    if ((Get-FileHash $sdkZip -Algorithm SHA1).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Android tools download checksum mismatch.' }
    $sdkStage = Join-Path $toolsDir 'sdk-unpack'
    Expand-Archive -LiteralPath $sdkZip -DestinationPath $sdkStage -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $sdkDir 'cmdline-tools') | Out-Null
    Move-Item -LiteralPath (Join-Path $sdkStage 'cmdline-tools') -Destination (Join-Path $sdkDir 'cmdline-tools/latest')
}
$env:JAVA_HOME = Join-Path $toolsDir 'jdk'
$env:ANDROID_HOME = $sdkDir
$env:ANDROID_SDK_ROOT = $sdkDir
$env:ANDROID_USER_HOME = Join-Path $toolsDir 'user'
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
$androidCli = Join-Path $sdkDir 'cmdline-tools/latest/bin/android.exe'
if (Test-Path $androidCli) {
    foreach ($sdkPackage in @('platform-tools', 'platforms;android-36', 'build-tools;36.0.0')) {
        & $androidCli --sdk $sdkDir sdk install $sdkPackage
        if ($LASTEXITCODE -ne 0) { throw "Android SDK package setup failed: $sdkPackage" }
    }
} else {
    $sdkManager = Join-Path $sdkDir 'cmdline-tools/latest/bin/sdkmanager.bat'
    1..30 | ForEach-Object { 'y' } | & $sdkManager "--sdk_root=$sdkDir" --licenses
    if ($LASTEXITCODE -ne 0) { throw 'Android SDK license setup failed.' }
    & $sdkManager "--sdk_root=$sdkDir" 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
    if ($LASTEXITCODE -ne 0) { throw 'Android SDK package setup failed.' }
}
& (Join-Path $env:JAVA_HOME 'bin/java.exe') -version
Write-Output 'Android toolchain is ready in .android-tools.'

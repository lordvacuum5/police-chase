<#
.SYNOPSIS
    Publishes the game, and the small ASP.NET server that hosts it, to the
    Azure Web App.

.DESCRIPTION
    The site runs on a Free (F1) Linux plan with DOTNETCORE|10.0, and basic
    publishing credentials are switched off for both FTP and SCM. That rules
    out FTP, the publish profile, and anything that wants a deployment
    password: the only way in is Microsoft Entra ID. This script gets a token
    from the Azure CLI (so `az login` first) and posts a zip to the Kudu
    deployment endpoint with it.

    What it does, in order:

      1. Checks the Azure CLI is present, logged in, and pointed at the right
         subscription, and reads the app's real host names from Azure rather
         than assuming them.
      2. Stages a copy of the server project with the game's files in its
         wwwroot (index.html, src, vendor, resources).
      3. Builds it -- locally with `dotnet publish` if a .NET 10 SDK is
         installed, otherwise by shipping the sources and letting Azure build
         them (-ServerBuild, and the default when no local SDK is found).
      4. Zips it, posts it, and waits for the deployment to finish.
      5. Waits for the site to answer, and opens it.

.PARAMETER ServerBuild
    Ship the sources and have Azure build them (Oryx) instead of building here.
    Chosen automatically when there is no .NET 10 SDK on this machine. Slower,
    and it uses the free plan's CPU quota, but it needs nothing installed.

.PARAMETER IncludeTests
    Also publish tests\, so the browser-console harnesses can be run against
    the deployed site. Off by default: they are development tools.

.EXAMPLE
    .\deploy-azure.ps1

.EXAMPLE
    .\deploy-azure.ps1 -ServerBuild -IncludeTests
#>
[CmdletBinding()]
param(
    [string] $SubscriptionId = '0dc4d6c9-9c1f-493e-b13c-18bcf67c0749',
    [string] $ResourceGroup  = 'police-chase',
    [string] $AppName        = 'police-chase',
    # Where the game's files are. Defaults to this script's own folder.
    [string] $GameRoot       = $PSScriptRoot,
    [switch] $ServerBuild,
    [switch] $IncludeTests,
    [switch] $SkipOpen,
    # Seconds to wait for the site to answer after deploying. A free plan has
    # no Always On, so the first request has to start the app.
    [int]    $StartupTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Windows PowerShell 5.1 still defaults to TLS 1.0 for some calls, and Azure
# accepts nothing below 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# The progress bar makes Invoke-WebRequest uploads an order of magnitude slower
# in 5.1.
$ProgressPreference = 'SilentlyContinue'

if (-not $GameRoot) { $GameRoot = (Get-Location).Path }
$GameRoot = (Resolve-Path $GameRoot).Path

function Write-Step([string] $Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Note([string] $Text) { Write-Host "    $Text" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- Azure CLI

function Get-AzCommand {
    $az = Get-Command az -ErrorAction SilentlyContinue
    if ($az) { return $az.Source }
    # Not on PATH in this shell is common; look where the installer puts it.
    $candidates = @(
        "$env:ProgramFiles\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
        "${env:ProgramFiles(x86)}\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
        "$env:LOCALAPPDATA\Programs\Azure CLI\wbin\az.cmd"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "Azure CLI not found. Install it (https://aka.ms/installazurecli), then run 'az login'."
}

$script:Az = Get-AzCommand

# Runs the CLI and returns its output, as an object when it is JSON. Native
# stderr is left alone: redirecting it in 5.1 turns a successful call into an
# error record.
function Invoke-Az {
    param([Parameter(Mandatory)][string[]] $Arguments, [switch] $Raw)
    $out = & $script:Az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
    if ($Raw) { return ($out -join "`n").Trim() }
    if (-not $out) { return $null }
    return ($out -join "`n") | ConvertFrom-Json
}

Write-Step 'Checking the Azure CLI'
$account = $null
try { $account = Invoke-Az @('account', 'show', '-o', 'json') } catch { $account = $null }
if (-not $account) { throw "Not signed in. Run 'az login' and try again." }
Write-Note "signed in as $($account.user.name)"

if ($SubscriptionId -and $account.id -ne $SubscriptionId) {
    Write-Note "switching to subscription $SubscriptionId"
    Invoke-Az @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
}

# ------------------------------------------------------------------ the app

Write-Step "Reading $AppName"
$app = $null
try {
    $app = Invoke-Az @('webapp', 'show', '-g', $ResourceGroup, '-n', $AppName, '-o', 'json')
} catch {
    throw "Web app '$AppName' not found in resource group '$ResourceGroup' on this subscription."
}

$siteHost = $app.defaultHostName
# The SCM host carries the app's unique suffix and its region, so it cannot be
# guessed from the app name -- ask Azure for it.
$scmHost = ($app.hostNameSslStates | Where-Object { $_.hostType -eq 'Repository' } | Select-Object -First 1).name
if (-not $scmHost) { $scmHost = "$AppName.scm.azurewebsites.net" }
$runtime = $app.siteConfig.linuxFxVersion
Write-Note "site    https://$siteHost"
Write-Note "deploy  https://$scmHost"
Write-Note "runtime $runtime"
if ($runtime -and $runtime -notmatch '^DOTNETCORE\|10') {
    Write-Warning "The app's runtime is '$runtime', not DOTNETCORE|10.0. The published app targets net10.0 and will not start on an older runtime."
}
if ($app.state -ne 'Running') {
    Write-Note "app state is $($app.state); starting it"
    Invoke-Az @('webapp', 'start', '-g', $ResourceGroup, '-n', $AppName) | Out-Null
}

# ------------------------------------------------------------------- build

function Get-DotnetCommand {
    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($dotnet) { return $dotnet.Source }
    foreach ($c in @("$env:ProgramFiles\dotnet\dotnet.exe", "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe")) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

$dotnetExe = Get-DotnetCommand
$hasNet10 = $false
if ($dotnetExe) {
    $sdks = & $dotnetExe --list-sdks
    $hasNet10 = @($sdks | Where-Object { $_ -match '^10\.' }).Count -gt 0
}
if (-not $ServerBuild -and -not $hasNet10) {
    Write-Note 'no .NET 10 SDK here, so Azure will build it (same as -ServerBuild)'
    $ServerBuild = $true
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path ([IO.Path]::GetTempPath()) "police-chase-deploy-$stamp"
$srcDir = Join-Path $work 'src'
$webRoot = Join-Path $srcDir 'wwwroot'
New-Item -ItemType Directory -Path $webRoot -Force | Out-Null

Write-Step 'Staging the site'
$serverDir = Join-Path $GameRoot 'server'
if (-not (Test-Path (Join-Path $serverDir 'PoliceChase.Server.csproj'))) {
    throw "No server project in $serverDir. Run this from the repository, or pass -GameRoot."
}
Copy-Item (Join-Path $serverDir '*.csproj') -Destination $srcDir
Copy-Item (Join-Path $serverDir '*.cs') -Destination $srcDir

$payload = @('index.html', 'src', 'vendor', 'resources')
if ($IncludeTests) { $payload += 'tests' }
foreach ($item in $payload) {
    $from = Join-Path $GameRoot $item
    if (-not (Test-Path $from)) { throw "Missing $from. Is -GameRoot '$GameRoot' the game's folder?" }
    Copy-Item $from -Destination $webRoot -Recurse -Force
}
$staged = Get-ChildItem $webRoot -Recurse -File
Write-Note ("{0} files, {1:N1} MB of game" -f $staged.Count, (($staged | Measure-Object Length -Sum).Sum / 1MB))

$zipRoot = $srcDir
if (-not $ServerBuild) {
    Write-Step 'Building (dotnet publish)'
    $outDir = Join-Path $work 'out'
    & $dotnetExe publish (Join-Path $srcDir 'PoliceChase.Server.csproj') `
        -c Release -o $outDir --nologo -v minimal
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }
    $zipRoot = $outDir
} else {
    Write-Step 'Azure will build it'
    Write-Note 'the zip carries the sources; Oryx runs dotnet publish on the server'
}

# Entry names have to use forward slashes. ZipFile.CreateFromDirectory on
# Windows PowerShell writes the platform's separator into them, and the Linux
# side then treats the whole path as one filename: the first attempt failed
# with 'failed to stat "/home/site/wwwroot/wwwroot\src\core\menu.js": Invalid
# argument' on every file in the zip.
function New-DeploymentZip {
    param([Parameter(Mandatory)][string] $SourceDir, [Parameter(Mandatory)][string] $ZipPath)
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $base = (Resolve-Path $SourceDir).Path.TrimEnd('\')
    $stream = [IO.File]::Open($ZipPath, [IO.FileMode]::Create)
    try {
        $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $SourceDir -Recurse -File) {
                $relative = $file.FullName.Substring($base.Length + 1).Replace('\', '/')
                $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
                $target = $entry.Open()
                try {
                    $source = [IO.File]::OpenRead($file.FullName)
                    try { $source.CopyTo($target) } finally { $source.Dispose() }
                } finally { $target.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
}

Write-Step 'Packing'
$zipPath = Join-Path $work 'deploy.zip'
New-DeploymentZip -SourceDir $zipRoot -ZipPath $zipPath
Write-Note ("{0:N1} MB" -f ((Get-Item $zipPath).Length / 1MB))

# --------------------------------------------------------------- settings

# Oryx only builds when it is told to, and only makes sense for a source zip.
# Setting this every time would restart the app for nothing, so only when it
# actually differs from what the site already has.
$wantBuild = if ($ServerBuild) { 'true' } else { 'false' }
$settings = Invoke-Az @('webapp', 'config', 'appsettings', 'list', '-g', $ResourceGroup, '-n', $AppName, '-o', 'json')
$current = ($settings | Where-Object { $_.name -eq 'SCM_DO_BUILD_DURING_DEPLOYMENT' } | Select-Object -First 1)
if (-not $current -or $current.value -ne $wantBuild) {
    Write-Step "Setting SCM_DO_BUILD_DURING_DEPLOYMENT=$wantBuild"
    Invoke-Az @('webapp', 'config', 'appsettings', 'set', '-g', $ResourceGroup, '-n', $AppName,
        '--settings', "SCM_DO_BUILD_DURING_DEPLOYMENT=$wantBuild", '-o', 'none') | Out-Null
}

# On Linux the platform picks the .dll to run by looking for one; saying so
# outright removes the guess, and costs a restart only when it changes.
$wantStartup = 'dotnet PoliceChase.Server.dll'
$config = Invoke-Az @('webapp', 'config', 'show', '-g', $ResourceGroup, '-n', $AppName, '-o', 'json')
if ($config.appCommandLine -ne $wantStartup) {
    Write-Step 'Setting the startup command'
    Invoke-Az @('webapp', 'config', 'set', '-g', $ResourceGroup, '-n', $AppName,
        '--startup-file', $wantStartup, '-o', 'none') | Out-Null
}

# Multiplayer is a WebSocket to /ws, and the platform will not upgrade the
# connection unless this is on. It is a setting, not a tier: no cost, though a
# free plan allows only a handful of sockets at once.
if (-not $config.webSocketsEnabled) {
    Write-Step 'Enabling WebSockets'
    Invoke-Az @('webapp', 'config', 'set', '-g', $ResourceGroup, '-n', $AppName,
        '--web-sockets-enabled', 'true', '-o', 'none') | Out-Null
}

# ---------------------------------------------------------------- deploy

# Basic authentication is disabled on this site, so Kudu is addressed with an
# Entra token. The audience it wants is ARM's; both of these have been the
# documented one at different times, so try the default and fall back.
function Get-KuduToken([string] $Resource) {
    if ($Resource) {
        return Invoke-Az @('account', 'get-access-token', '--resource', $Resource, '--query', 'accessToken', '-o', 'tsv') -Raw
    }
    return Invoke-Az @('account', 'get-access-token', '--query', 'accessToken', '-o', 'tsv') -Raw
}

function Invoke-KuduDeploy([string] $Token) {
    if ($ServerBuild) {
        # The build pipeline: this is the endpoint that runs Oryx (dotnet
        # publish) on the zip when SCM_DO_BUILD_DURING_DEPLOYMENT is on. The
        # one-deploy endpoint below does not -- it only copies files, which
        # with a source zip leaves the site with a .csproj and no application.
        $url = "https://$scmHost/api/zipdeploy?isAsync=true"
    } else {
        # Already built here, so just put the files in place. clean=true so
        # files deleted from the repository disappear from the site instead of
        # lingering; isAsync so the upload does not sit on one HTTP request.
        $url = "https://$scmHost/api/publish?type=zip&clean=true&restart=true&isAsync=true"
    }
    $headers = @{ Authorization = "Bearer $Token" }
    return Invoke-WebRequest -Uri $url -Method Post -Headers $headers `
        -InFile $zipPath -ContentType 'application/zip' `
        -UseBasicParsing -TimeoutSec 900
}

Write-Step 'Uploading'
$token = Get-KuduToken $null
$response = $null
try {
    $response = Invoke-KuduDeploy $token
} catch {
    $status = $null
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
        $status = [int] $_.Exception.Response.StatusCode
    }
    if ($status -eq 401 -or $status -eq 403) {
        Write-Note 'retrying with a management.core.windows.net token'
        $token = Get-KuduToken 'https://management.core.windows.net/'
        $response = Invoke-KuduDeploy $token
    } else {
        # A 502 here does not mean the deployment did not happen: the front end
        # gives up on the request while Kudu is still working, and the first
        # run of this script saw exactly that -- 502 on the upload, with the
        # deployment recorded (and failed) on the other side. Carry on to the
        # status poll, which knows what actually became of it.
        Write-Warning "The upload returned: $($_.Exception.Message)"
        Write-Note 'checking whether the deployment started anyway'
        $response = $null
    }
}

$statusUrl = $null
if ($response -and $response.Headers['Location']) { $statusUrl = [string] $response.Headers['Location'] }
if (-not $statusUrl) { $statusUrl = "https://$scmHost/api/deployments/latest" }

Write-Step 'Deploying'
$headers = @{ Authorization = "Bearer $token" }
$deadline = (Get-Date).AddMinutes(15)
$last = ''
$result = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    try {
        $result = Invoke-RestMethod -Uri $statusUrl -Headers $headers -UseBasicParsing -TimeoutSec 120
    } catch {
        continue   # Kudu returns 404 for a moment between accepting and starting
    }
    $text = ''
    if ($result.PSObject.Properties['status_text'] -and $result.status_text) { $text = [string] $result.status_text }
    if (-not $text -and $result.PSObject.Properties['message']) { $text = [string] $result.message }
    if ($text -and $text -ne $last) { Write-Note $text; $last = $text }
    $complete = $false
    if ($result.PSObject.Properties['complete']) { $complete = [bool] $result.complete }
    if ($complete) { break }
}

if (-not $result) { throw 'The deployment never reported a status. Check the Deployment Center in the portal.' }
# Kudu's status: 3 is failed, 4 is success.
$code = if ($result.PSObject.Properties['status']) { [int] $result.status } else { -1 }
if ($code -eq 3) {
    $log = if ($result.PSObject.Properties['log_url']) { $result.log_url } else { "https://$scmHost/api/deployments/latest/log" }
    throw "The deployment failed. Log: $log"
}
Write-Note 'deployment accepted'

# ----------------------------------------------------------------- warm up

Write-Step 'Waiting for the site'
$healthy = $false
$deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
$lastError = ''
while ((Get-Date) -lt $deadline) {
    try {
        $probe = Invoke-WebRequest -Uri "https://$siteHost/healthz" -UseBasicParsing -TimeoutSec 60
        if ($probe.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
        $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 5
}

Write-Host ''
if ($healthy) {
    Write-Host "  Live: https://$siteHost" -ForegroundColor Green
    if (-not $SkipOpen) { Start-Process "https://$siteHost" | Out-Null }
} else {
    Write-Warning "The site has not answered within $StartupTimeoutSec s. Last error: $lastError"
    Write-Host "  Logs: az webapp log tail -g $ResourceGroup -n $AppName" -ForegroundColor Yellow
}

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

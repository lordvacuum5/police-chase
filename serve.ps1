<#
    Static file server for the Police Chase game.

    Uses the .NET HttpListener built into Windows, so there is nothing to install.
    Modules and WASM must be served over HTTP -- opening index.html from disk
    directly will not work, because browsers refuse ES module imports on file://.

    Usage:   powershell -ExecutionPolicy Bypass -File .\serve.ps1
             powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 9000 -NoBrowser
#>
[CmdletBinding()]
param(
    [int]    $Port = 8123,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$Root = (Resolve-Path $Root).Path

$Mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.wasm' = 'application/wasm'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.map'  = 'application/json; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
    $listener.Start()
} catch {
    Write-Host "Could not bind port $Port. Is something already using it?" -ForegroundColor Red
    Write-Host "Try:  .\serve.ps1 -Port 8124" -ForegroundColor Yellow
    exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host '  POLICE CHASE - dev server' -ForegroundColor Cyan
Write-Host "  serving $Root"
Write-Host "  $url" -ForegroundColor Green
Write-Host '  Ctrl+C to stop.'
Write-Host ''

if (-not $NoBrowser) { Start-Process $url | Out-Null }

try {
    while ($listener.IsListening) {
        # Deliberately not the blocking GetContext(). PowerShell only handles
        # Ctrl+C between statements, and GetContext() does not return until a
        # request arrives -- so Ctrl+C appears to do nothing until you happen to
        # load a page. Polling an async wait hands control back every 200 ms,
        # which is what makes the console responsive.
        $task = $listener.GetContextAsync()
        while (-not $task.Wait(150)) { }
        $ctx = $task.GetAwaiter().GetResult()
        $req = $ctx.Request
        $res = $ctx.Response

        try {
            # Dev-only capture endpoint: the page POSTs a data: URL here and we
            # write the decoded image into .\shots\. Handy for checking how a
            # build actually looks without needing a screenshot tool.
            if ($req.HttpMethod -eq 'POST' -and $req.Url.AbsolutePath -eq '/__shot') {
                $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
                $payload = $reader.ReadToEnd()
                $reader.Close()

                $name = $req.QueryString['name']
                if (-not $name) { $name = 'shot' }
                $name = ($name -replace '[^A-Za-z0-9_\-]', '')
                if (-not $name) { $name = 'shot' }

                $comma = $payload.IndexOf(',')
                $ext = if ($payload -match '^data:image/png') { 'png' } else { 'jpg' }
                if ($comma -ge 0) { $payload = $payload.Substring($comma + 1) }

                $dir = Join-Path $Root 'shots'
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
                $out = Join-Path $dir "$name.$ext"
                [System.IO.File]::WriteAllBytes($out, [System.Convert]::FromBase64String($payload))

                $body = [System.Text.Encoding]::UTF8.GetBytes("saved $name.$ext")
                $res.StatusCode = 200
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                Write-Host ("  SHOT $name.$ext") -ForegroundColor Cyan
                $res.Close()
                continue
            }

            # The daily challenge's table, as server/Program.cs keeps it on the live site, so the game can be
            # tried here. Kept in the temp folder, not the project.
            if ($req.Url.AbsolutePath -eq '/api/daily') {
                $dir = Join-Path $env:TEMP 'police-chase-daily'
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
                $rows = @()
                $day = $req.QueryString['day']
                $post = $null
                if ($req.HttpMethod -eq 'POST') {
                    $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
                    $post = $reader.ReadToEnd() | ConvertFrom-Json
                    $reader.Close()
                    $day = [string]$post.day
                }
                if ($day -notmatch '^\d{4}-\d{2}-\d{2}$') {
                    $res.StatusCode = 400
                    $res.Close()
                    continue
                }
                $file = Join-Path $dir "$day.json"
                # Windows PowerShell hands a JSON array back as one object; unrolled, it is the rows.
                if (Test-Path -LiteralPath $file) { $rows = @((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) | ForEach-Object { $_ }) }
                $toJson = { param($list) '[' + ((@($list) | ForEach-Object { '{"name":' + (ConvertTo-Json ([string]$_.name)) + ',"time":' + ([double]$_.time).ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',"car":' + (ConvertTo-Json ([string]$_.car)) + '}' }) -join ',') + ']' }
                if ($post) {
                    $name = ([string]$post.name).Trim().ToUpperInvariant() -replace '[^A-Z0-9 _-]', ''
                    if ($name.Length -gt 16) { $name = $name.Substring(0, 16) }
                    $t = [double]$post.time
                    if ($name -and $t -ge 15 -and $t -le 900) {
                        $old = $rows | Where-Object { $_.name -eq $name }
                        if (-not $old -or $old.time -gt $t) {
                            $rows = @($rows | Where-Object { $_.name -ne $name })
                            $rows += [pscustomobject]@{ name = $name; time = [math]::Round($t, 2); car = [string]$post.car }
                            $rows = @($rows | Sort-Object time)
                            [System.IO.File]::WriteAllText($file, (& $toJson $rows))
                        }
                    }
                }
                $body = [System.Text.Encoding]::UTF8.GetBytes((& $toJson ($rows | Select-Object -First 20)))
                $res.ContentType = 'application/json; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                Write-Host ("  200  /api/daily {0}" -f $day) -ForegroundColor DarkGray
                $res.Close()
                continue
            }

            $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
            $rel = $rel -replace '/', '\'

            $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))

            # Refuse anything that escapes the project directory.
            if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $res.StatusCode = 403
                $res.Close()
                continue
            }

            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $ext   = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                $type  = $Mime[$ext]
                if (-not $type) { $type = 'application/octet-stream' }

                $res.ContentType = $type
                $res.Headers.Add('Cache-Control', 'no-store, must-revalidate')
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                Write-Host ("  200  {0}" -f $rel) -ForegroundColor DarkGray
            } else {
                $body = [System.Text.Encoding]::UTF8.GetBytes("404 - not found: $rel")
                $res.StatusCode = 404
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                Write-Host ("  404  {0}" -f $rel) -ForegroundColor Yellow
            }
        } catch {
            Write-Host ("  500  {0}" -f $_.Exception.Message) -ForegroundColor Red
            try { $res.StatusCode = 500 } catch { }
        } finally {
            try { $res.Close() } catch { }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Write-Host '  server stopped.'
}

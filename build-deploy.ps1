$ErrorActionPreference = "Stop"
Set-Location C:\dev\deep-video-downloader

# 1. install deps (idempotent)
npm install 2>&1 | Select-Object -Last 3

# 2. syntax check
npm run check 2>&1 | Select-Object -Last 3

# 3. build installer + unpacked app
npm run dist 2>&1 | Select-Object -Last 4

# 4. stop running app so files can be replaced
Get-Process -Name "DeepVideoDownloader" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# 5. deploy built output to C:\Program Files WITH ELEVATION
#    (a plain /S install silently fails to overwrite Program Files without admin)
$src = "C:\dev\deep-video-downloader\dist\win-unpacked"
$dst = "C:\Program Files\DeepVideoDownloader"
$cmd = "Copy-Item -Path '$src\*' -Destination '$dst\' -Recurse -Force"
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile", "-Command", $cmd -Wait
Start-Sleep -Seconds 1

Write-Host "BUILD + DEPLOY COMPLETE"

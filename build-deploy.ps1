$ErrorActionPreference = "Continue"
Set-Location C:\dev\deep-video-downloader
# NOTE: continue (not Stop) on errors - PS 5.1 turns npm's harmless stderr
# warnings ("npm warn ...") into terminating NativeCommandError records and
# aborts the whole deploy. Critical steps get explicit checks below.

# 1. install deps (idempotent)
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

# 2. syntax check
npm run check
if ($LASTEXITCODE -ne 0) { throw "npm run check failed ($LASTEXITCODE)" }

# 3. build installer + unpacked app
npm run dist
if ($LASTEXITCODE -ne 0) { throw "npm run dist failed ($LASTEXITCODE)" }
if (-not (Test-Path "dist\win-unpacked\DeepVideoDownloader.exe")) { throw "build produced no dist\win-unpacked\DeepVideoDownloader.exe" }

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

# 6. verify the copy actually landed (a silent no-op here is the classic
#    failure — Copy-Item -LiteralPath '...\*' does NOT glob and copies nothing)
$want = (Get-FileHash "dist\win-unpacked\resources\app.asar").Hash
$got = (Get-FileHash "$dst\resources\app.asar").Hash
if ($want -ne $got) { throw "DEPLOY FAILED: dist asar hash $want != installed $got - copy did not land" }
if (-not (Test-Path "$dst\resources\app.asar.unpacked\extension\manifest.json")) {
  throw "DEPLOY FAILED: extension not present under $dst\resources\app.asar.unpacked"
}
Write-Host "DEPLOY VERIFIED: asar hash $got + extension present"

Write-Host "BUILD + DEPLOY COMPLETE"

# 7. relaunch the installed app (it was stopped in step 4)
Start-Sleep -Seconds 1
if (-not (Get-Process -Name "DeepVideoDownloader" -ErrorAction SilentlyContinue)) {
  Start-Process "$dst\DeepVideoDownloader.exe"
  Write-Host "APP RESTARTED"
}

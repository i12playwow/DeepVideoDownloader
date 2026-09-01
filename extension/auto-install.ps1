# Auto-install Deep Grab into your NORMAL Chrome/Edge/Brave profile, IDM-style.
#
# HOW TO USE (after Deep Grab is published to the Chrome Web Store):
#   1. Find the extension's CWS URL / ID. After publishing, the listing URL looks like
#        https://chromewebstore.google.com/detail/deep-grab/<32-char-extension-id>
#      Copy the 32-character ID (e.g. abcdefghijklmnopqrstuvwxyzabcdef).
#   2. Run this script and enter that ID when prompted:
#        powershell -ExecutionPolicy Bypass -File extension\auto-install.ps1
#      (or pass it directly:  .\auto-install.ps1 -ExtensionId abcdefghijklmnopqrstuvwxyzabcdef)
#   3. Restart Chrome (fully close it first). Chrome auto-installs Deep Grab into your
#      normal profile and prompts you once to enable it.
#
# This writes the same Windows-registry mechanism that Chrome supports for extensions
# hosted on the Chrome Web Store. Chrome refuses local/unpacked auto-install for
# security (patched since Chrome 44), so the extension MUST be published first.

param(
  [string]$ExtensionId = "",
  [ValidateSet("chrome","edge","brave")]
  [string]$Browser = "chrome"
)

if (-not $ExtensionId) {
  $ExtensionId = Read-Host "Paste the 32-character Chrome Web Store extension ID"
}
$ExtensionId = $ExtensionId.Trim()
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Host "ERROR: '$ExtensionId' is not a 32-character Chrome extension ID (letters a-p only)." -ForegroundColor Red
  exit 1
}

# Registry roots: per-machine (HKLM) needs admin; per-user (HKCU) does not and is enough.
# Edge and Brave use their own software roots but read the same update mechanism.
$roots = switch ($Browser) {
  "chrome" { @("HKCU:\Software\Google\Chrome\Extensions", "HKLM:\Software\Google\Chrome\Extensions") }
  "edge"   { @("HKCU:\Software\Microsoft\Edge\Extensions", "HKLM:\Software\Microsoft\Edge\Extensions") }
  "brave"  { @("HKCU:\Software\BraveSoftware\Brave\Extensions", "HKLM:\Software\BraveSoftware\Brave\Extensions") }
}

$updateUrl = "https://clients2.google.com/service/update2/crx"
$wrote = $false

foreach ($root in $roots) {
  $keyPath = Join-Path $root $ExtensionId
  try {
    if (-not (Test-Path $keyPath)) { New-Item -Path $keyPath -Force | Out-Null }
    Set-ItemProperty -Path $keyPath -Name "update_url" -Value $updateUrl -Type String
    Write-Host "OK: wrote $keyPath" -ForegroundColor Green
    $wrote = $true
  } catch {
    Write-Host "SKIP: $keyPath ($($_.Exception.Message))" -ForegroundColor Yellow
  }
}

if ($wrote) {
  Write-Host ""
  Write-Host "Done. Fully close $Browser (check the tray too) and reopen it." -ForegroundColor Cyan
  Write-Host "Deep Grab will auto-install; go to chrome://extensions and enable it once if asked." -ForegroundColor Cyan
} else {
  Write-Host "Nothing written." -ForegroundColor Red
  exit 1
}

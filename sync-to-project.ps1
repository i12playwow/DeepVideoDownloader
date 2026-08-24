$src = "C:\dvdbak"
$dst = "C:\Users\SOKCHHORN PC\OneDrive\Desktop\Project WorkSpace\deep-video-downloader"
if (!(Test-Path $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
Get-ChildItem $src -Force | Where-Object { $_.Name -ne "node_modules" -and $_.Name -ne "dist" } | ForEach-Object {
  Copy-Item $_.FullName $dst -Recurse -Force
}
Write-Host "Synced $src -> $dst (excluding node_modules, dist)"

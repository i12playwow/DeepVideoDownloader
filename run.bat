@echo off
cd /d "C:\deep-video-downloader"
node_modules\electron\dist\electron.exe --no-sandbox --disable-gpu --disable-dev-shm-usage .

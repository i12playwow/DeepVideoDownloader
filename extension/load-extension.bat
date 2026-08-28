@echo off
rem Launch a temporary Chrome profile with the Deep Video Downloader extension loaded.
set "EXT=%~dp0"
set "EXT=%EXT:~0,-1%"
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%TEMP%\deepdl-chrome-test" --load-extension="%EXT%"

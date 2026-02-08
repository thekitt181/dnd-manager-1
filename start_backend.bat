@echo off
cd /d "%~dp0"
echo Starting Backend via PowerShell...
powershell -NoExit -ExecutionPolicy Bypass -Command "& { $nodePath = Join-Path $env:USERPROFILE '.trae\sdks\versions\node\current'; $env:PATH = $nodePath + ';' + $env:PATH; Write-Host 'Node Path added:' $nodePath; Write-Host 'Starting Backend on port 5174...'; npm run dev -- --port 5174 }"
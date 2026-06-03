@echo off
for /f "tokens=2" %%p in ('tasklist /v /fi "imagename eq node.exe" ^| findstr /i "leased-line-server leased-line-client"') do taskkill /pid %%p /f

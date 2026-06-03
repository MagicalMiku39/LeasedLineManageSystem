@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: publish-v1.cmd https://github.com/your-name/your-repo.git
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not available in PATH.
  echo Install Git for Windows first, then run this script again.
  exit /b 1
)

if not exist .git (
  git init
)

git branch -M main
git add .gitignore index.html package.json package-lock.json start-dev.cmd stop-dev.cmd publish-v1.cmd client server 专线台账管理系统需求设计.md 移植部署说明.md
git commit -m "Release v1.0" || echo Commit skipped or already exists.
git tag -a v1.0 -m "v1.0" || echo Tag v1.0 already exists.

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "%~1"
) else (
  git remote set-url origin "%~1"
)

git push -u origin main
git push origin v1.0

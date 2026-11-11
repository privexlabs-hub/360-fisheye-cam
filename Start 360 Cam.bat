@echo off
rem Double-click to run 360 Fisheye Cam on this Windows PC.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 serve.py & goto :eof)
where python >nul 2>nul && (python serve.py & goto :eof)
echo Python 3 is needed. Install it from https://www.python.org/downloads/ and double-click this file again.
pause

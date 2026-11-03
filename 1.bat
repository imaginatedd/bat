@echo off
chcp 65001 >nul
setlocal

REM Адрес шлюза OmniRoute (без /v1)
set "ANTHROPIC_BASE_URL=http://localhost:20128"

REM Ключ, созданный в Dashboard OmniRoute
set "ANTHROPIC_AUTH_TOKEN=sk-your-omniroute-key"

REM
set "ANTHROPIC_MODEL=kr/claude-sonnet-4.5"

claude %*

endlocal
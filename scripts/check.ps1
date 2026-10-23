$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $taskRoot
try {
    $taskNode = if (Get-Command node -ErrorAction SilentlyContinue) {
        'node'
    } elseif (Test-Path -LiteralPath 'tmp\runtime\node.exe') {
        '.\tmp\runtime\node.exe'
    } else {
        throw 'Node.js is required. Install Node.js or place node.exe in tmp\runtime.'
    }
    Get-ChildItem -LiteralPath 'extension' -Filter '*.js' | ForEach-Object {
        & $taskNode --check $_.FullName
        if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($_.Name)" }
    }
    & $taskNode --test tests/core.test.cjs tests/background.test.cjs tests/content.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed' }
    $taskPython = if (Test-Path -LiteralPath '.venv\Scripts\python.exe') { '.\.venv\Scripts\python.exe' } else { 'python' }
    & $taskPython -m unittest discover -s service/tests -v
    if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }
} finally {
    Pop-Location
}

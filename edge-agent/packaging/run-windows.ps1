$ErrorActionPreference = 'Stop'
$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile = Join-Path $BaseDir 'edge-agent.env'
if (-not (Test-Path $ConfigFile)) {
    throw "Missing $ConfigFile. Create it from edge-agent.env.example."
}

Get-Content $ConfigFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
        $parts = $line.Split('=', 2)
        if ($parts.Count -eq 2) {
            [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
        }
    }
}

& (Join-Path $BaseDir 'blue-team-edge-agent-windows-x64.exe')
exit $LASTEXITCODE

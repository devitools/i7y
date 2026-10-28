param(
    [Parameter(Mandatory=$true)][string]$BinaryPath,
    [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run the installer from an elevated PowerShell window.' }
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
if ($config.mode -ne 'host' -or $config.url -notmatch '^https://' -or $config.token -notmatch '^i7ya_[A-Za-z0-9]{64}$') { throw 'A host-mode configuration and dedicated agent credential are required.' }
$root = Join-Path $env:ProgramData 'i7y-agent'
$taskName = 'i7y host telemetry'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'An existing installation must be reconciled before replacement.' }
if (Test-Path -LiteralPath $root) { throw 'The agent directory already exists; inspect it before replacing files.' }
New-Item -ItemType Directory -Path $root | Out-Null
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict agent directory permissions.' }
$state = Join-Path $root 'state'
New-Item -ItemType Directory -Path $state | Out-Null
& icacls.exe $state /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict queue permissions.' }
$exe = Join-Path $root 'i7y-host.exe'
$destinationConfig = Join-Path $root 'config.json'
Copy-Item -LiteralPath $BinaryPath -Destination $exe
$config | Add-Member -NotePropertyName state_dir -NotePropertyValue $state -Force
[System.IO.File]::WriteAllText($destinationConfig, ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
& $exe -config $destinationConfig -diagnose
if ($LASTEXITCODE -ne 0) { throw 'API validation failed; no scheduled task was installed.' }
$action = New-ScheduledTaskAction -Execute $exe -Argument ('-once -config "' + $destinationConfig + '"')
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$startup = New-ScheduledTaskTrigger -AtStartup
$service = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($periodic,$startup) -Principal $service -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Host telemetry task installed. Verify the received sample in i7y.'

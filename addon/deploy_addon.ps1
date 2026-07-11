# Consegna l'add-on "Bollette Backend" sul Raspberry, nella share Samba 'addons'
# di Home Assistant. NON installa né riavvia nulla: dopo la copia si passa dalla
# UI di HA (Impostazioni -> Componenti aggiuntivi -> Store -> menu ⋮ ->
# "Verifica aggiornamenti" -> sezione add-on locali -> Bollette Backend).
#
# NB: il CODICE dell'app non viaggia da qui — quello si pubblica come sempre
# con "Pubblica su NAS" dalle Impostazioni dell'app (finisce in /config/www/bollette).
$ErrorActionPreference = 'Stop'

$srcAddon = Join-Path $PSScriptRoot 'bollette_backend'   # ...\Bollette\addon\bollette_backend
$repo     = Split-Path $PSScriptRoot -Parent             # ...\Bollette
$shareRoot = '\\192.168.1.15\addons'
$dest      = Join-Path $shareRoot 'bollette_backend'

if (-not (Test-Path $shareRoot)) {
    Write-Host "ERRORE: share $shareRoot non raggiungibile (il Pi e' acceso? add-on Samba attivo?)" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force $dest | Out-Null

Copy-Item (Join-Path $srcAddon 'config.yaml') $dest -Force
Copy-Item (Join-Path $srcAddon 'Dockerfile')  $dest -Force
Copy-Item (Join-Path $srcAddon 'run.sh')      $dest -Force
Copy-Item (Join-Path $srcAddon 'README.md')   $dest -Force
# La fonte di verita' delle dipendenze e' il requirements.txt del repo.
Copy-Item (Join-Path $repo 'requirements.txt') $dest -Force

# run.sh DEVE avere fine-riga LF: gira in un container Linux (CRLF rompe lo shebang).
$shPath = Join-Path $dest 'run.sh'
$sh = [IO.File]::ReadAllText($shPath).Replace("`r`n", "`n")
[IO.File]::WriteAllText($shPath, $sh)

Write-Host "Add-on consegnato in $dest" -ForegroundColor Green
Get-ChildItem $dest | Select-Object Name, Length | Format-Table -AutoSize
Write-Host "Ora dalla UI di HA: Store add-on -> ⋮ -> Verifica aggiornamenti -> Bollette Backend -> Installa." -ForegroundColor Yellow

# Test push PRO300 — LACTiO N2
# Ejecutar SOLO con doble clic en PROBAR-PUSH-PRO300.bat
# O en terminal Cursor:  .\scripts\test-pro300-push.ps1

$logFile = Join-Path $PSScriptRoot "ultimo-test-push.txt"
$lines = New-Object System.Collections.Generic.List[string]

function Log($msg) {
  Write-Host $msg
  $lines.Add($msg)
}

Log "========================================"
Log " TEST PUSH PRO300 - $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')"
Log "========================================"
Log ""
Log "Enviando lectura (temp 12.5 C, AR24=10, retardo AR26=5 min)..."

$headers = @{
  apikey         = "sb_publishable_wi66yVcEeu7Y_44mkfNHIg_9-nbkHeb"
  Authorization  = "Bearer sb_publishable_wi66yVcEeu7Y_44mkfNHIg_9-nbkHeb"
  "Content-Type" = "application/json"
}

$body = @{
  moduleId    = "Multi"
  deviceToken = "441644"
  temp1_c     = 12.5
  sentAt      = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json

try {
  $r = Invoke-RestMethod `
    -Method POST `
    -Uri "https://fohbhymulrmdsgrubtlo.supabase.co/functions/v1/ingest-reading" `
    -Headers $headers `
    -Body $body

  Log ""
  Log "=== RESULTADO ==="
  Log "ok:              $($r.ok)"
  Log "kind:            $($r.kind)"
  Log "params_updated:  $($r.params_updated_at)"
  Log "pull_params_now: $($r.pull_params_now)"

  if ($r.push) {
    Log ""
    Log "=== PUSH (esto es lo importante) ==="
    Log "sent:    $($r.push.sent)"
    if ($r.push.skipped) { Log "skipped: $($r.push.skipped)" }
    if ($r.push.lastError) { Log "error:   $($r.push.lastError)" }
    if ($r.push.sent -ge 1) {
      Log ""
      Log "OK: Push enviado. Mira el CELULAR o la bandeja de notificaciones."
    } elseif ($r.push.skipped -eq "no_subscriptions") {
      Log ""
      Log "FALTA: Activa avisos en la APP -> Comunidad -> Activar en este navegador"
    } elseif ($r.push.skipped -eq "vapid_not_configured") {
      Log ""
      Log "FALTA: Configurar VAPID en secrets de Supabase (Edge Functions)"
    } else {
      Log ""
      Log "Push intentado pero no entregado. Revisa skipped/error arriba."
    }
  } else {
    Log ""
    Log "=== SIN PUSH TODAVIA ==="
    Log "Esto es NORMAL si:"
    Log "  - Es la primera vez que corres el test"
    Log "  - No pasaron 5 minutos desde la primera vez (AR26=5)"
    Log ""
    Log "QUE HACER:"
    Log "  1. Anota la hora de ESTE test"
    Log "  2. Espera 5 MINUTOS completos"
    Log "  3. Volve a hacer doble clic en PROBAR-PUSH-PRO300.bat"
    Log ""
    Log "En Supabase SQL puedes verificar:"
    Log "  select temp_breach_episode_started_at, last_push_temp_breach_at"
    Log "  from combistatos where module_id = 'Multi';"
  }

  Log ""
  Log "=== JSON COMPLETO ==="
  Log ($r | ConvertTo-Json -Depth 5)
} catch {
  Log ""
  Log "ERROR: $($_.Exception.Message)"
}

Log ""
Log "Resultado guardado en:"
Log $logFile
$lines | Set-Content -Path $logFile -Encoding UTF8

Write-Host ""
Write-Host "Abre el archivo ultimo-test-push.txt en la carpeta scripts para leer el resultado." -ForegroundColor Cyan
Read-Host "Enter para cerrar"

; Windows installer hooks, included by electron-builder's NSIS template (electron-builder.config.json: nsis.include).
; The install path reaches PowerShell only through CLOUDROOM_INSTALL_DIR, never quoted into the command line, and an
; empty path matches nothing, so these never touch processes outside this install.
!include LogicLib.nsh

; The bundled Python runs the preview and Mac access helper from the install folder and keeps its files open, so
; install and uninstall stop it first. Exits 1 if it still runs after 5 s.
!macro stopPreviewHelper
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOUDROOM_INSTALL_DIR", t "$INSTDIR")i'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = $$env:CLOUDROOM_INSTALL_DIR; if (-not $$dir) { exit 0 }; $$left = { Get-CimInstance Win32_Process | Where-Object { $$_.Name -like 'python*.exe' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) } }; for ($$i = 0; $$i -lt 20 -and @(& $$left).Count -gt 0; $$i++) { & $$left | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 250 }; exit [int](@(& $$left).Count -gt 0)"`
  Pop $0
!macroend

; Waits up to 5 s for Cloudroom from this install folder to quit (an update restarts it), then asks the user.
!macro cloudroomAppCheck
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOUDROOM_INSTALL_DIR", t "$INSTDIR")i'
  cloudroom_app_check:
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = $$env:CLOUDROOM_INSTALL_DIR; if (-not $$dir) { exit 0 }; $$left = { Get-CimInstance Win32_Process | Where-Object { $$_.Name -like 'Cloudroom*.exe' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) } }; for ($$i = 0; $$i -lt 20 -and @(& $$left).Count -gt 0; $$i++) { Start-Sleep -Milliseconds 250 }; exit [int](@(& $$left).Count -gt 0)"`
  Pop $0
  ${If} $0 == 1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Cloudroom is still running. Quit it, then click Retry." /SD IDCANCEL IDRETRY cloudroom_app_check
    Quit
  ${EndIf}
!macroend

!macro customInit
  !insertmacro stopPreviewHelper
!macroend

!macro customUnInit
  !insertmacro stopPreviewHelper
!macroend

!macro customCheckAppRunning
  !insertmacro cloudroomAppCheck
!macroend

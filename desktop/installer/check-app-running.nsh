; Before the installer or the uninstaller replaces or removes files: a running
; EvoScientist is asked to quit through its own quit (the busy question, the
; wait for the memory workers, the stops), instead of electron-builder's
; check, which ends every process in the install folder at once - the app's
; main process, and with it (through its job object) the app's backend and
; any running task, without a question.
;
; The app is every process in the install folder but a UI server (the app's
; executable running resources\ui-entry.mjs): the app's own UI server ends
; with the app, and one started on its own never ends by itself.
;
; 1. The app does not run: go on.
; 2. Start "EvoScientist.exe --quit-for-install": the app's single-instance
;    lock hands it to the running app, which quits as on File > Quit (with
;    none running, that start just exits).
; 3. Wait for the app to end, up to 3 minutes (the memory wait alone can
;    take 2).
;    - The user answered Cancel: the app leaves quit-for-install-cancelled in
;      its userData. The installer says so and stops.
;    - Still running after 3 minutes: a silent run ends the processes;
;      otherwise the installer asks to close the app and retry, or stops.
; 4. End every process still in the install folder: a UI server left alone.
;
; PowerShell gets the install folder in EVO_INSTDIR, not in its command line,
; so no character of the path (an apostrophe in a user name) can break the
; command. It answers 0 (the app runs) or 2 (it does not); any other result
; (PowerShell blocked or missing, a timeout) falls back to electron-builder's
; own check by process name for the user, which also counts a UI server. The
; folder is matched with a trailing "\", so a folder whose name only starts
; with the app's (a test build's) is left alone. Names are kept in
; sync with desktop/src/app.ts (QUIT_FOR_INSTALL, QUIT_FOR_INSTALL_CANCELLED)
; and desktop/package.json (the ui-entry.mjs resource).

!macro EVO_APP_RUNNING _RETURN
  ; 0 when the app runs (a process in the install folder, not a UI server),
  ; else 1.
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith($$env:EVO_INSTDIR + '\', 'CurrentCultureIgnoreCase') -and [string]$$_.CommandLine -notlike '*ui-entry.mjs*'}).Count -gt 0) { exit 0 } else { exit 2 }"`
  Pop ${_RETURN}
  ${If} ${_RETURN} != 0
  ${AndIf} ${_RETURN} != 2
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    StrCpy ${_RETURN} 1
  ${EndIf}
!macroend

!macro EVO_END_ALL _RETURN
  ; Ends every process in the install folder; 0 when there was one.
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$p = @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith($$env:EVO_INSTDIR + '\', 'CurrentCultureIgnoreCase')}); $$p | % { Stop-Process -Id $$_.ProcessId -Force }; if ($$p.Count -gt 0) { exit 0 } else { exit 2 }"`
  Pop ${_RETURN}
!macroend

!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "EVO_INSTDIR", t "$INSTDIR") i'
  StrCpy $R3 "$APPDATA\${PRODUCT_NAME}\quit-for-install-cancelled"
  evoCheck:
    !insertmacro EVO_APP_RUNNING $R0
    StrCmp $R0 0 0 evoDone
    Delete "$R3"
    DetailPrint "Asking ${PRODUCT_NAME} to quit..."
    Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-install`
    StrCpy $R2 0
  evoPoll:
    Sleep 1000
    IfFileExists "$R3" evoCancelled
    !insertmacro EVO_APP_RUNNING $R0
    StrCmp $R0 0 0 evoDone
    IntOp $R2 $R2 + 1
    IntCmp $R2 180 0 evoPoll 0
    IfSilent evoKill
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is still running. Close it (File > Quit), then press Retry. Cancel stops the installer." IDRETRY evoCheck
    Quit
  evoCancelled:
    Delete "$R3"
    MessageBox MB_OK|MB_ICONINFORMATION "${PRODUCT_NAME} keeps running, so nothing was changed. Close ${PRODUCT_NAME}, then run the installer again." /SD IDOK
    Quit
  evoKill:
    DetailPrint "Ending ${PRODUCT_NAME}..."
  evoDone:
    !insertmacro EVO_END_ALL $R0
    ${If} $R0 == 0
      Sleep 1000
    ${EndIf}
!macroend

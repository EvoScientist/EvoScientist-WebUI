; Before the installer or the uninstaller replaces or removes files: a running
; EvoScientist is asked to quit through its own quit (the busy question, the
; wait for the memory workers, the stops), instead of electron-builder's
; check, which ends every process in the install folder at once - the app's
; main process, and with it (through its job object) the app's backend and
; any running task, without a question.
;
; The app is every process of the app's executable in the install folder but
; a UI server (the executable running resources\ui-entry.mjs): the app's own
; UI server ends with the app, and one started on its own never ends by
; itself. Other programs there are left alone: an old uninstaller that the
; installer runs in place (when a copy in %TEMP% cannot run) would otherwise
; wait for itself, then end itself.
;
; 1. The app does not run: go on.
; 2. Start "EvoScientist.exe --quit-for-install": the app's single-instance
;    lock hands it to the running app, which quits as on File > Quit (with
;    none running, that start just exits).
; 3. Wait for the app to end, about 3 minutes by the clock (the memory wait
;    alone can take 2).
;    - The user answered Cancel: the app leaves quit-for-install-cancelled in
;      its userData. The installer says so and stops.
;    - Still running after 3 minutes: a silent run ends the processes;
;      otherwise the installer asks to close the app and retry, or stops.
; 4. End every process of the app's executable still running: a UI server
;    left alone.
; 5. Check again, the UI server included: while any process of the app's
;    executable still runs (or the check gets no answer), its files cannot be
;    replaced, so the installer asks to close the app and retry, or stops (a
;    silent run stops).
;
; PowerShell gets the executable's path in EVO_APP_EXE, not in its command
; line, so no character of the path (an apostrophe in a user name) can break
; the command. It answers 0 (the app runs) or 2 (it does not); any other
; result (PowerShell blocked or missing, no output for 30 s) falls back to a
; check by process name for the user, like electron-builder's own, which
; also counts a UI server; without PowerShell nothing is ended by force
; (step 4, or a silent run after 3 minutes). Names are kept in sync with
; desktop/src/app.ts (QUIT_FOR_INSTALL, QUIT_FOR_INSTALL_CANCELLED) and
; desktop/package.json (the ui-entry.mjs resource).

!macro EVO_APP_RUNNING _RETURN
  ; 0 when the app runs (its executable, not a UI server), else 1.
  nsExec::Exec /TIMEOUT=30000 `"$PowerShellPath" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -eq $$env:EVO_APP_EXE -and [string]$$_.CommandLine -notlike '*ui-entry.mjs*'}).Count -gt 0) { exit 0 } else { exit 2 }"`
  Pop ${_RETURN}
  ${If} ${_RETURN} != 0
  ${AndIf} ${_RETURN} != 2
    nsExec::Exec /TIMEOUT=30000 `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    StrCpy ${_RETURN} 1
  ${EndIf}
!macroend

!macro EVO_ANY_RUNNING _RETURN
  ; 0 when any process of the app's executable runs (a UI server too), or
  ; when no check answers; else 1.
  nsExec::Exec /TIMEOUT=30000 `"$PowerShellPath" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -eq $$env:EVO_APP_EXE}).Count -gt 0) { exit 0 } else { exit 2 }"`
  Pop ${_RETURN}
  ${If} ${_RETURN} != 0
  ${AndIf} ${_RETURN} != 2
    nsExec::Exec /TIMEOUT=30000 `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RETURN}
    ; findstr: 0 found, 1 not found; anything else is no answer.
    ${If} ${_RETURN} != 0
    ${AndIf} ${_RETURN} != 1
      StrCpy ${_RETURN} 0
    ${EndIf}
  ${EndIf}
  ${If} ${_RETURN} != 0
    StrCpy ${_RETURN} 1
  ${EndIf}
!macroend

!macro EVO_END_ALL _RETURN
  ; Ends every process of the app's executable; 0 when there was one.
  nsExec::Exec /TIMEOUT=30000 `"$PowerShellPath" -NoProfile -NonInteractive -C "$$p = @(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -eq $$env:EVO_APP_EXE}); $$p | % { Stop-Process -Id $$_.ProcessId -Force }; if ($$p.Count -gt 0) { exit 0 } else { exit 2 }"`
  Pop ${_RETURN}
!macroend

!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "EVO_APP_EXE", t "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i'
  StrCpy $R3 "$APPDATA\${PRODUCT_NAME}\quit-for-install-cancelled"
  evoCheck:
    !insertmacro EVO_APP_RUNNING $R0
    StrCmp $R0 0 0 evoDone
    Delete "$R3"
    DetailPrint "Asking ${PRODUCT_NAME} to quit..."
    Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-install`
    System::Call 'kernel32::GetTickCount()i.R2'
  evoPoll:
    Sleep 1000
    IfFileExists "$R3" evoCancelled
    !insertmacro EVO_APP_RUNNING $R0
    StrCmp $R0 0 0 evoDone
    System::Call 'kernel32::GetTickCount()i.R4'
    IntOp $R4 $R4 - $R2
    IntCmpU $R4 180000 evoPoll evoPoll 0
    IfSilent evoKill
  evoStill:
    !ifdef BUILD_UNINSTALLER
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is still running. Close it (File > Quit), then press Retry. Cancel stops the uninstall." /SD IDCANCEL IDRETRY evoCheck
    !else
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is still running. Close it (File > Quit), then press Retry. Cancel stops the installer." /SD IDCANCEL IDRETRY evoCheck
    !endif
    Quit
  evoCancelled:
    Delete "$R3"
    !ifdef BUILD_UNINSTALLER
      MessageBox MB_OK|MB_ICONINFORMATION "${PRODUCT_NAME} keeps running, so nothing was removed. Close ${PRODUCT_NAME}, then uninstall it again." /SD IDOK
    !else
      MessageBox MB_OK|MB_ICONINFORMATION "${PRODUCT_NAME} keeps running, so nothing was changed. Close ${PRODUCT_NAME}, then run the installer again." /SD IDOK
    !endif
    Quit
  evoKill:
    DetailPrint "Ending ${PRODUCT_NAME}..."
  evoDone:
    !insertmacro EVO_END_ALL $R0
    ${If} $R0 == 0
      Sleep 1000
    ${EndIf}
    !insertmacro EVO_ANY_RUNNING $R0
    StrCmp $R0 0 evoStill
!macroend

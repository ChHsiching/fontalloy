; FontAlloy NSIS hooks (round 22, owner ruling: uninstall must remove
; the downloaded font catalog with the app — nothing of ours may be
; orphaned in AppData). The GUI's catalog storage is the Tauri
; app-data directory %APPDATA%\<identifier>; the identifier matches
; tauri.conf.json. Keep the two in sync when either changes.

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$APPDATA\io.github.chhsiching.fontalloy"
!macroend

# First-run download UX patterns for large optional content catalogs

Research date: 2026-11-17. Scope: established interaction patterns for apps that ship with a large optional content catalog — specifically the two-option first-run model (download everything now vs skip and download per item on demand), what the catalog list shows before any download, and the progress/gating rules. Evidence comes from PRIMARY sources only (official product documentation, help pages, and vendor manuals), collected to ground the ruled product decision for FontAlloy's first-run screen (「下载全部字体」 vs 「按需下载/跳过」, 103 families / ~48 GB).

## Question

For a desktop font tool that currently force-downloads a 48 GB catalog on first run: what do comparable products do when the catalog is large but optional? Sub-questions: (1) is browsing the full catalog allowed before any download; (2) what does a list entry show pre-download (metadata vs real glyph preview); (3) what happens when the user clicks an entry (inline progress? modal? queue?); (4) is a "download everything" option ever offered, and how; (5) is the choice remembered, can it change, is "skip" ever nagged again; (6) failure/retry wording norms.

## Per-domain findings

### 1. Font managers

#### FontBase (official docs at fontba.se)

1. The Google Fonts catalog is listed in full before anything is downloaded. On first open, the sidebar already contains a "Google" folder under Providers; the underlying font files are NOT on disk yet — the provider folder in the Root folder "will appear as soon as you activate your first Google font." Source: https://fontba.se/learn/google-fonts

2. Download is strictly per-font, triggered by the ordinary activation action: "the font is downloaded from Google servers, activated and stored locally in your Root folder and can then be used as any other font file." There is no bulk "download all Google fonts" command documented anywhere in the official docs. Source: https://fontba.se/learn/google-fonts

3. Gating rule is explicitly two-state per font: already-downloaded fonts work offline like any local file; for the rest, "this does require an active internet connection for the fonts that have not yet been downloaded." The docs never describe a first-run download prompt. Source: https://fontba.se/learn/google-fonts

4. Since update 2.5.0, catalog fonts are first-class list citizens — Google fonts "can now be added to collections like any other font," i.e., the catalog entry is the unit of interaction, not a separate "store" mode. Source: https://fontba.se/updates/2.5.0

#### RightFont (official docs at rightfontapp.com)

5. Catalog sync is a separate, explicit step from font download: select Google Fonts in the sidebar and click "Sync Now"; after syncing finishes "you will have access to all the Google Fonts in RightFont" — i.e., the full catalog becomes browsable in the library. New Google Fonts additions are kept current automatically ("designed to stay up-to-date with the latest additions"). Source: https://rightfontapp.com/docs/cloud-fonts/google-fonts

6. Fonts are activated "on-demand": the FAQ says RightFont "activates missing fonts on demand, allowing you to use them within your design software without the need for manual font searching and installation," and auto-activation activates required fonts in the background when a document opens. Source: https://rightfontapp.com/faqs and https://rightfontapp.com/docs/auto-activate-missing-fonts

7. Previewing does not require activation: users can type custom text in the preview field to preview catalog fonts without activating them. Source: https://rightfontapp.com/docs/view-fonts/edit-font-preview-text

#### Google Fonts (fonts.google.com — official FAQ and site behavior)

8. The entire catalog (~1,800 families) is browsable with zero prior download; the site IS the catalog browser. Per-family pages offer a "Download family" button that downloads a zip of that one family. Source: https://fonts.google.com (site behavior); per-family download button documented across the site's specimen pages.

9. There is no in-app "download the whole collection" button. The official FAQ routes bulk/self-host users out of the app to GitHub: "You can use our GitHub to download font files to install or self host... Check it out at github.com/google/fonts." The full-download path exists, but as a separate channel for power users, not a first-run choice. Source: https://fonts.google.com/faq

10. Previews do not require the full font files: "our servers will automatically send the smallest possible file to every user" — the web API serves browser-tailored, subsetted pieces ("pieces of it"), not the entire font, for rendering. This is the strongest precedent for showing real glyph previews from tiny subset files while full files download only on demand. Source: https://fonts.google.com/faq (Privacy / advantages sections)

### 2. Asset libraries and stores

#### Adobe Fonts (Creative Cloud — official helpx articles)

11. The full subscription library is browsable before any activation: "Start by browsing the library of fonts," with filters by language, classification, properties, and natural-language mood tags. Family pages show specimens and let the user "Select the font weights and styles you want to use, or use the menu at the top of the list to add full families." Activation granularity is per weight/style or per family. Source: https://helpx.adobe.com/fonts/web/introduction/add-fonts-desktop.html

12. Activating = downloading on demand. Nothing in the library is on disk until the user activates; activated fonts then appear under the f icon in Creative Cloud desktop and in every app's font menu. Source: https://helpx.adobe.com/fonts/web/introduction/add-fonts-desktop.html

13. Storage is managed aggressively and reversibly, never re-nagged: "Adobe Fonts that have not been used in several months need to be reinstalled... Creative Cloud keeps apps running smoothly by periodically cleaning up fonts that you don't appear to be using. You can quickly reinstall fonts from the Creative Cloud desktop by clicking the Install button next to the font name in your Added Fonts list." Removed fonts are tracked in a "Previously Added" tab "so you can easily add them again at any time." Adobe also recommends keeping the added list short — the opposite of forcing a full download. Source: https://helpx.adobe.com/fonts/web/introduction/add-fonts-desktop.html

#### Unity Editor — Package Manager "My Assets" (official Unity Manual)

14. The My Assets list shows every acquired package (name, version, details panel) before download. If "the package hasn't been downloaded to this machine before, the details panel shows a Download button"; after download it is replaced by "Import #.# to project" and "Re-download #.#" menu entries. Source: https://docs.unity3d.com/6000.2/Documentation/Manual/upm-ui-import.html

15. Progress and cancel controls are inline, in the details panel where the Download button was: "During download, a progress bar appears, and Pause and Cancel buttons replace the Download button. Pause suspends the download (a Play button resumes it); Cancel stops it entirely." Source: https://docs.unity3d.com/6000.2/Documentation/Manual/upm-ui-import.html

16. Two-step model (acquire → download → import) keeps browsing free: packages acquired on the web Asset Store appear in My Assets "immediately" (docs.unity.cn mirror), but no bytes move until Download is clicked in the editor. Source: https://docs.unity.cn/2021.1/Documentation/Manual/AssetPackagesPurchase.html and https://docs.unity3d.com/6000.2/Documentation/Manual/upm-ui-import.html

#### Blender — Extensions platform (official Blender Manual)

17. Blender ships with NO bundled extension content beyond add-ons; the Preferences > Get Extensions panel lists the remote repository's catalog, and install is per item on demand: "Search for the extension name and click on Install." An offline path exists: "Install from Disk... This is installed to a Local Repository and no updates will be available." Source: https://docs.blender.org/manual/en/latest/editors/preferences/extensions.html

18. Update checking is opt-in and non-nagging: "Check for Updates on Startup: Allows Blender to check for updates upon launch. When updates are available a notification will be visible on the status bar" — a passive badge, not a dialog. Updates are otherwise manual ("You need to manually check for available updates"), with an "Update All" button only once updates are found. Source: https://docs.blender.org/manual/en/latest/editors/preferences/extensions.html

#### Figma Community (official Help Center)

19. Community resources are fully previewable in the browser before any copy is made: "Each Community file has a resource page showing file details and a preview of the file or prototype. You can interact with these previews like a regular embed." The action button is "Open in Figma"/"Open in FigJam"; clicking it duplicates a fresh copy into the user's drafts (filename gets "(Community)" appended); paid files offer "Get free preview" to trial before buying. Nothing is copied until that explicit click. Source: https://help.figma.com/hc/en-us/articles/360038510873-Duplicate-Community-files

### 3. Game launchers

#### Steam (official Steam Support FAQ)

20. First run downloads nothing but the client: the store is a browsable catalog and the library fills per title. Downloads are gated per game and per explicit install action; "You can also pick the install location from all of your existing Library folders when downloading a new game." Source: https://help.steampowered.com/en/faqs/view/71AB-698D-57EB-178C

21. The Download Manager is the single progress surface: "From here you can track the progress of your downloads, schedule updates, re-order your update queue and see which updates have been completed." Queue order is user-controlled; "your queued downloads can be manually re-ordered from your Download Manager." Source: https://help.steampowered.com/en/faqs/view/71AB-698D-57EB-178C

22. Download discipline controls are first-class: bandwidth limits ("a bandwidth limit can be setup... displayed in the upper right corner of the Download Manager"), auto-update scheduling windows ("Only auto-update games between..."), per-game update policy ("Always keep this game updated" / "Only update this game when I launch it" / "High Priority"), and post-hoc storage management ("Move Install Folder..." without re-downloading). Source: https://help.steampowered.com/en/faqs/view/71AB-698D-57EB-178C

#### EA app (official EA help)

23. Per-game download from the Library: "Find the game that you want to download and select the arrow in the bottom-right corner. Confirm your Install location and Language preferences, then select Next. Select Download." A confirm step precedes the transfer, exposing location and language — but browsing the Library and Store is unrestricted with zero games installed. Source: https://help.ea.com/en/articles/platforms/download-and-play-ea-app-games

24. Downloads queue and continue out of view: enabling "Update games automatically" and "Enable background downloads" lets the app "download queued games even when it's closed." Offline rules are explicit and time-boxed: offline play requires having launched the game online at least once, and works "for 30 days since it was last launched online." Source: https://help.ea.com/en/articles/platforms/download-and-play-ea-app-games

25. Failure wording is consumer-plain, e.g. the troubleshooting article title "Games that won't download, install, or load in the EA app" — symptom-first language, no error codes in user-facing headings. Source: https://help.ea.com/en/articles/orders-and-rewards/ea-app-game-download-installation-loading-not-working

#### Epic Games Launcher (official Epic help)

26. Same shape: Library lists owned games; per game, "Select the installation directory you wish to use, and then click Install"; "click on the cogwheel icon next to the Install button to manually select the installation directory"; "Once the download is complete, you can click the icon to launch the game." A global default install location lives under Downloads settings. Source: https://www.epicgames.com/help/en-US/epic-games-store-c-32735058/launcher-support-c-36403860/how-do-i-install-a-game-using-the-epic-games-launcher-a16010803 and https://www.epicgames.com/help/c-32735058/c-36403860/how-do-i-change-the-default-installation-path-for-my-games-on-the-epic-games-launcher-a23672320

### 4. OS-level optional content

#### Windows Optional Features / Features on Demand (Microsoft Learn, official)

27. The design intent is stated outright: "Features on Demand (FODs) are Windows features that can be added at any time... When Windows 11 or Windows Server needs a new feature, it can request the feature package from Windows Update." Payloads are not preinstalled; they are fetched when the feature is added (offline media is the enterprise fallback). Source: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/features-on-demand-v2--capabilities?view=windows-11

28. The consumer UI lists everything, downloads on selection: Settings > System > Optional features > "View features" opens the "Add an optional feature" window; users check boxes next to features ("Multiple features can be selected"), press Next, review the selection, and press Add. Online requirement is plain-language: "The device needs to be online so Windows Update can download the content that it needs to add." Installed features get an "Installed features" list with a Remove button. Source: https://learn.microsoft.com/en-us/windows/client-management/client-tools/add-remove-hide-features

#### macOS Font Book — downloadable system fonts (Apple Support, official)

29. macOS lists downloadable system fonts IN the main font list, marked with a per-item download affordance: "System fonts you can download show a download button in the Font Book window." Actions: "Click the Download button next to a font. Control-click a font, then choose Download. Select multiple fonts, Control-click the selection, then choose Download." The full list is visible before download; each not-yet-downloaded font carries its own Download control. Source: https://support.apple.com/guide/font-book/install-and-validate-fonts-fntbk1000/mac

#### macOS VoiceOver voices (Apple Support, official)

30. Voices are auditioned and fetched on demand: "Click [Play] to hear a sample of the voice, then click a voice to add it. If the voice isn't already downloaded to your Mac, click [Download], then click the voice when the download is complete." Installed voices land in /Library/Speech/Voices system-wide. The pick list shows all voices up front; download is a per-voice button inside the picker. Source: https://support.apple.com/guide/voiceover/unac009/mac

## CONVERGENT PATTERN

Across all four domains the same rules recur; where one product deviates, noted.

1. **The catalog is always browsable before any download.** Every surveyed product shows the complete catalog listing (names + metadata + some preview) with zero content on disk: FontBase's Google folder, RightFont after "Sync Now", the Google Fonts site, Adobe Fonts, Unity My Assets, Blender Get Extensions, Figma Community, Steam Store, EA/Epic libraries, Windows "View features", Apple Font Book's downloadable system fonts. Browsing is never gated behind a bulk download. Our current force-download-first-run is an outlier against every product surveyed.

2. **Download is per item, triggered from the list entry itself.** The dominant action is: click/toggle the entry's affordance (FontBase activation, Adobe family toggle, Font Book Download button, Unity Download button, Apple voice Download, Windows feature checkbox + Add, Steam/Epic Install). No surveyed product offers an in-app "download the entire catalog now" button at first run; the only full-collection channel found is Google Fonts routing power users to a GitHub repo (finding 9), i.e., a separate out-of-app path. A first-run "download all" button is therefore unprecedented in this set — our 「下载全部字体」 option should be framed as a convenience shortcut that queues 103 per-family downloads, not as a different mode.

3. **Pre-download, a list entry shows full metadata and a degraded-but-real preview.** Google Fonts renders true previews from server-side subsetted "smallest possible" files (finding 10); Adobe Fonts and RightFont show live specimen previews from the cloud; Apple shows the font entry with a Download badge instead of glyphs; Windows shows feature names without the feature. So: metadata always; glyph preview either from tiny subsets (web model) or replaced by a download affordance (OS model).

4. **On click: inline, non-modal progress at the entry, with a queue behind it.** Unity replaces the Download button in place with a progress bar plus Pause/Cancel (finding 15); Steam tracks everything in a Download Manager where the queue can be reordered (finding 21); EA queues downloads that continue in the background (finding 24); Apple's picker keeps the list usable while a voice downloads ("click the voice when the download is complete", finding 30). Nothing blocks the rest of the catalog during a download.

5. **The choice is never a one-time trap, and skip is never nagged.** No surveyed app re-prompts users who declined to download. The per-item affordance simply remains available forever (Font Book's download buttons, Unity's Download, Adobe's activate toggles). Passive, dismissable indicators are the only reminder mechanism (Blender's status-bar update badge, finding 18). Adobe goes further and quietly UN-downloads unused content, with a one-click reinstall — storage is treated as the user's resource, not the product's (finding 13).

6. **Offline behavior is defined per item, not globally.** FontBase: internet needed only "for the fonts that have not yet been downloaded" (finding 3). EA: offline play allowed for games previously launched online (finding 24). Windows: needs to be online only while adding a feature (finding 28). The rule: downloaded items work offline; not-downloaded items show a clear needs-network state.

7. **Failure and retry wording is symptom-first, plain-language, with retry as the same verb as the original action.** EA's troubleshooting is titled "Games that won't download, install, or load" (finding 25); Windows says "The device needs to be online..." (finding 28); Unity's retry is literally the "Re-download" button (finding 14); Adobe's reinstall is an "Install" button next to the font name (finding 13). No error codes or engineering jargon in user-facing copy; retry reuses the download affordance in place.

## Recommendations for FontAlloy's first-run screen

Mapped to the ruled decision: first run offers 「下载全部字体」(full download, per-family progress) vs 「按需下载/跳过」(download nothing; catalog lists all 103 families; clicking a family downloads it on the spot; local-file-only users never download).

1. **Button wording — action + consequence, size disclosed.** Primary: 「下载全部字体」with the total size and count stated on the button or directly beneath (e.g., 「下载全部字体（103 个字族 · 约 48 GB）」). Secondary: 「跳过，按需下载」. Rationale: launchers disclose the commitment before transfer (EA confirms install location then Download, finding 23; Steam exposes library-folder choice at new-game download, finding 20); a 48 GB commitment is the largest in this survey by far and must be stated up front. Avoid the word 「安装」 — font tools uniformly say download/activate (FontBase, Adobe, Font Book all use download/activate verbs).

2. **Treat 「下载全部字体」 as a queued batch of per-family downloads, not a distinct mode.** It should enter the same per-family queue and show the same per-family progress the skip path uses (Steam queue model, finding 21; EA background queue, finding 24), with pause/cancel available per family (Unity inline Pause/Cancel, finding 15). If interrupted, resume at family granularity; families already completed stay usable immediately (FontBase: activated-then-local semantics, finding 2).

3. **After skip (and by default), the catalog list stays exactly as today — all 103 families, full metadata.** Never filter, hide, or watermark-not-downloadable entries into a second-class list (finding 1: every product keeps one unified catalog). Each family entry carries a persistent download affordance in its normal row/card position (Font Book per-font Download button, finding 29; Unity per-package Download, finding 14).

4. **Pre-download glyph previews: serve small subset files, never the full family.** To keep the list "exactly as today," render specimen previews from a few-KB subset per family shipped with the app or fetched once (Google Fonts' official model: "the smallest possible file," finding 10). Full glyph inspection inside a family page can gate on the family download completing. If a subset cannot be shipped for some family, fall back to the Font Book pattern: entry + metadata + download button, no fake glyph render (finding 29).

5. **On-click download UX for a family: inline, non-modal.** Clicking a not-downloaded family replaces its download affordance with inline progress (bar or percentage + current size) plus cancel; the family detail view that the user clicked into may show the same progress and enable the preview the moment the family lands (Unity in-place replacement, finding 15; Apple voice "click the voice when the download is complete", finding 30). Multiple simultaneous family downloads serialize in a small queue surfaced in one place (Steam Download Manager, finding 21) — a corner/badge indicator is enough; never a modal that blocks catalog browsing.

6. **Remember the choice as a reversible preference; never re-prompt.** Store the first-run decision (e.g., downloadMode: all | onDemand | localOnly). 「按需下载」 is the default behavior of the catalog anyway, so "skip" needs no follow-up nag, badge, or banner (finding 5). If the full download was skipped or canceled, the only future trace is the persistent per-family download buttons — plus, at most, a settings entry like 「补齐全部字体」 that re-queues the batch (Blender's opt-in "Check for Updates on Startup" + passive badge is the ceiling of acceptable reminder behavior, finding 18). Local-file-only users (offline mode) see no download prompts at all; not-downloaded families display a plain offline state (FontBase wording model: connection needed only for fonts not yet downloaded, finding 3).

7. **Failure/retry copy: symptom-first Chinese, no jargon, retry reuses the same verb.** Pattern per finding 7: 「“{字族名}”下载失败」+ one plain cause line (「请检查网络连接」) + 「重试」 button in place; on resume, show 「继续下载」. Mirror EA/Windows style: state the symptom in the user's terms (下载失败/未完成), never HTTP codes, mirror names, or CDN jargon. For the full-catalog batch, per-family failures retry individually and never invalidate completed families (Adobe reinstall-in-place model, finding 13).

8. **Housekeeping follows the Adobe precedent: downloads are revocable, re-downloadable, and never silently re-fetched.** Removing a downloaded family returns it to the not-downloaded list state with its download button intact (Adobe "Previously Added", finding 13; Windows "Installed features" > Remove, finding 28). Updates to family content check only on explicit action or a passive badge (Blender, finding 18) — important because a 48 GB catalog that auto-refetches would repeat the original offense.

## Source index

- FontBase — Google Fonts: https://fontba.se/learn/google-fonts ; update 2.5.0: https://fontba.se/updates/2.5.0
- RightFont — Google Fonts sync: https://rightfontapp.com/docs/cloud-fonts/google-fonts ; FAQ: https://rightfontapp.com/faqs ; auto-activation: https://rightfontapp.com/docs/auto-activate-missing-fonts ; preview text: https://rightfontapp.com/docs/view-fonts/edit-font-preview-text
- Google Fonts FAQ: https://fonts.google.com/faq (whole-collection via github.com/google/fonts; smallest-possible-file serving)
- Adobe Fonts — Add fonts on your computer: https://helpx.adobe.com/fonts/web/introduction/add-fonts-desktop.html ; EA-style troubleshooting title pattern: https://helpx.adobe.com/fonts.html (help index)
- Unity Manual — Download and import an asset package: https://docs.unity3d.com/6000.2/Documentation/Manual/upm-ui-import.html ; purchase/sync flow: https://docs.unity.cn/2021.1/Documentation/Manual/AssetPackagesPurchase.html
- Blender Manual — Get Extensions: https://docs.blender.org/manual/en/latest/editors/preferences/extensions.html ; extensions platform: https://extensions.blender.org
- Figma Help — Duplicate Community files: https://help.figma.com/hc/en-us/articles/360038510873-Duplicate-Community-files
- Steam Support — Managing Steam Downloads & Updates: https://help.steampowered.com/en/faqs/view/71AB-698D-57EB-178C
- EA help — Download and play games in the EA app: https://help.ea.com/en/articles/platforms/download-and-play-ea-app-games ; troubleshooting: https://help.ea.com/en/articles/orders-and-rewards/ea-app-game-download-installation-loading-not-working
- Epic Games help — Install a game: https://www.epicgames.com/help/en-US/epic-games-store-c-32735058/launcher-support-c-36403860/how-do-i-install-a-game-using-the-epic-games-launcher-a16010803 ; default install path: https://www.epicgames.com/help/c-32735058/c-36403860/how-do-i-change-the-default-installation-path-for-my-games-on-the-epic-games-launcher-a23672320
- Microsoft Learn — Features on Demand: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/features-on-demand-v2--capabilities?view=windows-11 ; Add/remove/hide features (Settings UX): https://learn.microsoft.com/en-us/windows/client-management/client-tools/add-remove-hide-features
- Apple Support — Font Book install/validate/download system fonts: https://support.apple.com/guide/font-book/install-and-validate-fonts-fntbk1000/mac ; VoiceOver voices: https://support.apple.com/guide/voiceover/unac009/mac

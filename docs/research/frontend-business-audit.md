# Frontend business-logic audit — input to spec #25 (core unification)

Snapshot: 2026-10-17, branch `fix/pick-pattern` (fcaaea6). Read-only audit feeding the core-unification migration. All paths are absolute at snapshot time.

## 1. gui/src inventory (21,811 LOC TS; +9,783 LOC css/json data)

### catalog/ — first-run downloader + variant model (all BUSINESS, must move to core)

- `gui/src/catalog/manager.ts` (598) — `CatalogManager`: fetch release doc, verify families via storage, sha256 via WebCrypto (`sha256Hex` :57-67), zip fetch+unzip+per-face verify+persist (`downloadFamily` :227-255), boot FontFace sweep (`registerVerified` :281-343), per-family registration (`ensureRegistered` :391-452), face-set sweep (`registerFamilyFaces` :467-574). Singleton :590-598.
- `gui/src/catalog/release.ts` (211) — strict parser/validator of `catalog-release.json` (`parseCatalogRelease` :59-84; origins :94-125; families :127-165). TS twin of `core/fontalloy_core/catalog_release.py`.
- `gui/src/catalog/zip.ts` (96) — minimal ZIP reader; stored+deflate via `DecompressionStream("deflate-raw")` (`unzip` :27-89).
- `gui/src/catalog/faceSet.ts` (130) — variant→face-set predicate `faceMatchesVariant` :66-95 (nf/cn/hw/mono/vf/gb/tc/screen/plus tokens), `variantFaceFiles` :97-105, `pickVariantRepresentative` :118-130. Pure.
- `gui/src/catalog/variantAxes.ts` (315) — manifest→display rows/cuts model: `displayFamilies` :97-115, cut collapse `computeVariantCuts` :235-300, `dataCutLabel` :182-194, `cutLabels` :207-217. Reads `data/catalog.json`.
- `gui/src/catalog/stars.ts` (218) — GitHub API stars fetch once/launch (`refreshStars` :151-218), repo→family mapping :39-62, blob-storage cache.
- `gui/src/catalog/screen.ts` (90) — RENDERING: first-run progress overlay; renders `store.catalog`.

### fonts/ — sfnt parsing + FontFace registry (all BUSINESS except the DOM calls)

- `gui/src/fonts/sfnt.ts` (949) — full sfnt metadata reader: `parseFontMeta` :131-193, name-table chain `readFamilyName` :282-364, coverage+cmap4/12 :372-417/:916-949, placeholder heuristics (glyf outline compare :498-765, CFF charstrings :776-914, mass-duplication threshold :431). Mirrors core `placeholder.py`/`normalize.py`.
- `gui/src/fonts/ttc.ts` (283) — .ttc face extraction/reassembly into standalone sfnt (`collectionFaceOffsets` :64-79, `extractFaceAtOffset` :98-194 incl. checkSumAdjustment recompute :174-188, `expandLocalFontEntries` :247-283).
- `gui/src/fonts/registry.ts` (432) — `registerFontBytes` :92-132 (the FontFace(ArrayBuffer) path), style-slot resolver `resolveStyleSlots` :200-211, local-file loader `registerLocalFontFiles` :243-429.
- `gui/src/fonts/localFamily.ts` (217) — same-directory sibling discovery (`sweepLocalFamily` :177-217; Tauri listing :94-116; service-index fallback :131-166).

### service/ — serve client + synthesize flow

- `gui/src/service/client.ts` (351) — typed HTTP client: health/fonts/catalog/systemFonts/systemFontBytes/build/cancelBuild/report/submit/fontBytes (:252-350). Byte fetches `systemFontBytes` :275-292, `fontBytes` :336-350.
- `gui/src/service/state.ts` (164) — VIEW-MODEL: `synthStore` :119-165.
- `gui/src/service/synthesize.ts` (911) — BUSINESS (recipe/pattern logic) + RENDERING (cards): `connectService` :102-148; `familyCutPattern` :187-195, `localFamilyPattern` :209-217, `pickPathPattern` :393-436, `resolvePickSlot` :486-520, `resolveFontPath` :226-239; `buildWorkspaceDraft` :334-375; build/poll/save/cancel `synthesize` :590-652, `runBuild` :664-767, `saveBuildAs` :854-900.
- `gui/src/service/systemfonts.ts` (165) — BUSINESS (grouping) + VIEW-MODEL: poll `ensureSystemFonts` :89-114, `groupSystemFamilies` :53-76, byte load+register `registerSystemFamily` :129-151.

### platform/ — environment adapters

- `gui/src/platform/storage.ts` (188) — `BlobStorage` interface :28-41; IndexedDB backend :53-111 (DB `fontalloy-storage`, store `blobs`); Tauri fs backend :125-167; `createStorage` :172-188.
- `gui/src/platform/config.ts` (243) — `CATALOG_TAG`/`CATALOG_REPO` :58-59, `DEV_CATALOG_URL` :70, `DEFAULT_SERVE_ADDRESS` "http://127.0.0.1:7777" :185, `?serve=` parsing :188-206, `readConfig` :208-243.
- `gui/src/platform/localfonts.ts` (108) — Tauri `pick_font_files`/`read_font_file`/`read_font_path`/`list_font_dir` invocations :37-108.
- `gui/src/platform/artifacts.ts` (196) — output-dir localStorage :44-79, savers :104-196 (Tauri raw-IPC save + browser blob-anchor download :150-164).
- `gui/src/platform/index.ts` (48) — `detectTarget`/`capabilities` :25-48.

### precedence/ — client-side mirror of core precedence (BUSINESS)

- `resolve.ts` (242) — faithful TS mirror of `core/precedence.py` `resolve_precedence`.
- `serialize.ts` (99) — rules→recipe BuilderRule[]/named sets.
- `model.ts` (117), `picks.ts` (100), `sets.ts` (92), `live.ts` (61) — model + set composition; `live.ts` builds the memoized `EffectiveResolver` used by grid/scenes.

### recipe/ — recipe model + writers + validation mirror (BUSINESS)

- `model.ts` (197) — draft model mirroring `core/recipe.py`.
- `validate.ts` (208) — client mirror of core validation.
- `json.ts` (107), `yaml.ts` (176) — wire/CLI serializers.
- `settings.ts` (164) — settings→normalization/weights; `patternFaceSlots`/`fileFaceSlots` face-slot enumeration.

### state.ts / main.ts / history.ts

- `state.ts` (276) — VIEW-MODEL + BUSINESS constants: `LoadedFont` :84-116, `CatalogState` :144-152, boot-preset seeding :217-231.
- `main.ts` (128) — RENDERING + boot wiring: mounts :36-100; service connect :90; stars :96; catalog manager spawn :110-128.
- `history.ts` (170) — RENDERING/interaction (undo stacks).

### ui/ + kit/ + unicode/ + data/ — RENDERING / VIEW-MODEL (stays)

- ui/: `buildpanel.ts` (1549), `charmap.ts` (1407; exports `appMessages` :255), `picker.ts` (954 — view-model assembling rows from catalog.json + curated-meta + registered fonts + system families; selection flows :437-509), `rulelist.ts` (328), `rail.ts` (82), `settings.ts` (276), `scenes.ts` (189), `statsbar.ts` (126), `topbar.ts` (152), `content.ts` (95), `missing.ts` (70), `noservice.ts` (255 — CLI fallback panel builds recipe YAML from same state), `live.ts` (29), `wincontrols.ts` (123).
- kit/: component library (pickerPopup 613, actionBar 520, contextMenu 405, messages 402, sceneContent 418, sceneCard 282, topBar 291, appSelect 241, grid 234, settingsTopics 249, charPopup 246, helpPopover 166, rangePopup 169, theme 161, ruleRows 160, categoryChips 142, langChips 88, statusBar 103, metaLine 57, icons 112, position 49, tokens 206, demo/, kit.css 2430, tokens.css 485).
- unicode/: `blocks.ts` (426), `universe.ts` (128), `visible.ts` (730, GENERATED — do not edit).
- data/: `catalog.json` (1354 lines; 114 entries, 102 distinct families — mirror of `assets/fonts.manifest.json`), `curated-meta.json` (414 — stars/trait/groups/slots/front, display-only), `presets.json` (3433), `preset-sets.ts` (355, GENERATED).

## 2. Byte-handling sites

- IndexedDB: `platform/storage.ts:53-56` (open :57-68, get :84-89, put :92-99); Tauri fs byte path :133-146.
- Release-doc fetch `catalog/manager.ts:121-124` (30 s timeout :43); origin-ordered zip fetch :206-219 with `res.arrayBuffer()` :214 (whole zip in RAM), sha256 :215, 10 min timeout :44; release-doc copy :143-150.
- ArrayBuffer→FontFace: `fonts/registry.ts:103-115` (+descriptors :106-109), `:394-402` (local siblings); `catalog/manager.ts:548-556` (face-set siblings per (weight,style) winner). Feeding reads: `manager.ts:406`, `:508`, `fonts/localFamily.ts:101`.
- Zip extraction in memory: `manager.ts:232` (unzip → whole family in RAM), verified Map :236-248, writes :251-254.
- Local files: `ui/picker.ts:99-106` (`file.arrayBuffer()`); `platform/localfonts.ts:58-65` (Tauri `read_font_file` → ArrayBuffer over raw IPC, 428 MB collections included).
- Service byte fetches: `service/client.ts:275-292` (`systemFontBytes` whole file), `:336-350` (`fontBytes` artifact as Uint8Array for saving).
- TS parsing: `fonts/sfnt.ts:131-193` (ttcf first-face, woff/woff2 unsupported), `fonts/ttc.ts` (whole module).

## 3. Memory blowup path

1. `main.ts:110-128` — bootstrap URL set → `new CatalogManager(...)` → `run()` fire-and-forget.
2. `manager.ts:281-343` — `registerVerified` iterates ALL release families; per family `ensureRegistered` :391-452 → `storage.read` whole face :406 → `parseFontMeta` :411 (second full-buffer pass) → `registerFontBytes` :413 → `new FontFace(cssFamily, buffer)` + `document.fonts.add` (registry.ts:103-111). **No `document.fonts.delete` anywhere in gui/src — buffers pinned forever.** Multi-entry families register EVERY cut's representative (:312-333). Waves of 8 + setTimeout(0) yields keep the UI responsive while RSS climbs.
3. Scale: 102 families × representatives (catalog itself is GB-range since full-family per-cut zips). ~2 GB observed as the paging-IO storm.
4. Interaction growth: pick → `registerFamilyFaces` (manager.ts:467-574) reads EVERY stored face (:508), registers each (weight,style) winner as a real FontFace holding its buffer (:548-556); 16-weight families multiply.
5. Download spike: whole zip arrayBuffer (:214) + unzip Map (:232) + verified Map duplicating every face (:236-248) before writes.

## 4. Core today

- Layout: `core/fontalloy_core/` — 26 modules, 8,889 LOC. serve.py 1071, build.py 995, recipe.py 925, report.py 530, assets.py 493, normalize.py 463, load.py 448, render.py 420, precedence.py 383, graft.py 369, systemfonts.py 317, catalog.py 287, placeholder.py 271, rewrite.py 267, notices.py 235, matrix.py 232, release.py 201, catalog_release.py 192, presets.py 188, recipe_release.py 160, output.py 134, origins.py 84, errors.py 44.
- serve: `cli/fontalloy_cli/main.py:141-250` → `core/serve.py` (ThreadingHTTPServer, 127.0.0.1, one build worker, CORS, stdin watchdog).
- Endpoints: `/health`, `/catalog` (manifest families only), `/fonts` (local dirs, depth-1), `/system-fonts` (lazy scan, ready flag), `/system-fonts/file?path=`, `/builds` GET/POST, `/builds/{id}` GET, `/builds/{id}/cancel` POST, `/builds/{id}/font` GET, `/builds/{id}/report` GET.
- Reusable core logic (not yet exposed over HTTP): `assets.py` `fetch_catalog` :64-129, `download_verified` :142-180 (temp-file streaming sha256 atomic replace), archive kind :183-194, `extract_font_faces` :197-225, `_validate_face_parses` :228-236, `_entry_files` :453-493 (pattern narrowing), `resolve_recipe_fonts` :357-388, chunked `sha256_of` :328-334; `catalog_release.py` `load_catalog_release` :72-97; `origins.py` `fetch_from_origins` :37-84; `release.py` `package_catalog_release`; `load.py` `scan_families`/`aggregate_families`.

## 5. web/ consumer

- Entry: `web/index.html:26` → `../gui/src/main.ts` (same frontend). `web/vite.config.ts`: base "./", `VITE_WEB_CATALOG="1"`, devCatalogPlugin, port 5174 dev / 4173 preview.
- Serve discovery: `?serve=` loopback-only param; `DEFAULT_SERVE_ADDRESS = http://127.0.0.1:7777`. Documented flow: run `fontalloy serve --port 7777 --allow-origin <origin>`, open `<site>/?serve=...`.
- What breaks when the frontend goes full serve-API: the page-side `/dev-catalog` bootstrap path becomes unused by the app (dev-catalog.mjs stays for tests); `/fonts` already mirrors the desktop families layout; the current `/catalog` endpoint lacks face/zip/variant data the pickers need; system fonts and save flows unaffected.

## 6. Tauri layer (526 LOC Rust — already thin)

- `lib.rs`: plugins fs/shell/dialog :456-459; sidecar spawn :382-451 (`serve --port 0 --font-dir <appData>/catalog/families --system-cache-dir ...`, ALLOWED_ORIGINS, stdin watch); `serve_url` :90-111; local font commands `pick_font_files` :115-136, `read_font_file` :146-153 (blocking pool), `list_font_dir` :167-190, `read_font_path` :209-243; save commands :250-365; `open_external` :371-379; window built in Rust :485-496. No business logic.

## 7. Governing docs

- ADR-0002 (python core, HTTP consumers — the architecture this migration enforces), ADR-0005 (catalog manifest + first-run download — runtime strategy to rewrite), DESIGN.md :10-17 architecture, AGENTS.md implementation order.

## 8. Test landscape

- Core pytest: `tests/` 25 files — serve contract suite `test_cli_serve.py` (31) + conftest (493) is the pattern for new endpoint tests; assets/origins/catalog suites cover the reuse targets.
- gui Playwright: 37 specs. Die with their modules: `catalog.spec.ts` (page-side downloader), `manager-variant-faces`/`ttc`/`placeholder`/`countertruth` (client mirrors — assertions move to core), `localload`/`fonts` (FontFace byte path, rewritten). Survive: kit, design, interactions, overlays, scenes, workspace, styleparity, sceneparity, ots, bulk, missing, unload, loadingrows, contextmenu, scriptregion, screenshots, journeys J1–J10, synthesize/cancelbuild/savecollision/systemfonts (serve contract unchanged).
- web: workspace/catalog/live-merge/noservice/journey specs against the built site; full catalog = GB scale (subset manifest for fast suite).
- `catalog-diag.spec.ts` (137) — round-30 throwaway diagnostic; its observability hooks (sweep attribute, fetch tap, error capture) are the template for the owner-scenario regression spec.

## 9. Phasing inputs

- Business-at-risk total ≈ 7,200 LOC TS of 21,811 (catalog/ 1,548; fonts/ 1,881; precedence/ 711; recipe/ 852; service/ ~1,591; platform/ 735).
- Pure and dependency-free (knowledge already in core): sfnt.ts, ttc.ts, faceSet.ts, variantAxes.ts, precedence/resolve.ts, recipe/validate.ts.
- Byte/IO spine: storage.ts → release+zip+manager → registry.ts → synthesize.ts, ending at ui/picker.ts and service/synthesize.ts (call sites `synthesize.ts:226-239/:393-520` are what the serve-side catalog endpoints replace).
- `state.ts` types (`LoadedFont`, `FontCatalogIdentity` :78-116) sit under everything — the registry type moves last.

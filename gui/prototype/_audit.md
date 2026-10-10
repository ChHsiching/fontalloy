# FontAlloy prototype interaction audit (run after every change round)

Lesson from an earlier round: programmatic `element.click()` bypasses hit-testing
and inertness, producing "all green in tests, dead under a real mouse". Real
clickability must be verified with real input events.

## How to run

Start the dev server, then in Playwright / the browser console:

1. **Hit scan** (paste into evaluate): for every visible interactive element in
   the current state, take its center coordinates and run
   `document.elementFromPoint(x, y)` — the hit must land inside the element
   itself. Cover every step and every open-overlay state. Any blocked hit is a
   real defect.
2. **Real-mouse regression** (Playwright `page.mouse.click(x, y)`): focus on
   the "open an overlay, then click a control inside it" combinations —
   dialog cancel/confirm, fullscreen prev/next/close, char pop "use base
   font", range pop "add", and window controls.
3. **False-positive checklist**:
   - Elements with `transition: visibility` report hidden when sampled at
     t=0; wait 220 ms before asserting.
   - Before asserting a button, confirm it is actually visible in that state
     (e.g. for a char that already comes from the CJK font, "use CJK font" is
     hidden by design).

## Known traps

- Overlay hosts must sit outside the inert subtree as siblings of the
  inerted content. (The modal-host/selectors listed in the original wizard-era
  draft are obsolete; in the current prototype the only overlay host is
  `#zoom-h`, a sibling inside `.app`.)
- `.pop` popups live at the body level and are not affected by window
  inertness.
- Real-click paths for buttons inside the fullscreen view (`.zf`) are
  verified.
- Two classes of hit-scan false positives (proven in round r12): controls
  inside an unopened `.pop:not(.open)` still report geometry
  (`visibility:hidden` does not clear the rect) and read as "blocked"; cells
  half-clipped at a scroll container's edge have their center outside the
  container, so the hit lands on the footer/grid below. Filter both: skip
  hidden-pop subtrees and verify the center sits inside the nearest clipping
  scroll box (see the r12 audit script).
- Components with a fixed dark background (`.term`, dark `.code-c[data-ct]`
  themes) must carry their own light base color instead of inheriting the
  theme text color — otherwise dark text on dark background in the light
  theme.
- Special characters in terminal/doc samples must be written as real Unicode
  (❯ ✔ ⚡ 世界), never as `\\u` escapes; Write/Edit tool escaping stacks with
  JS escaping and renders as literal text.
- Font-picker rows (`.fp`): the stars/license/tag metadata must be nowrap,
  and the tag needs ellipsis + max-width, or a long tag squeezes the family
  name into a vertical stack.

## r25 lesson: vision prompts must include open-ended review

When vision was only asked to verify "the items I changed", it went blind to
other obvious layout problems on the same screen (e.g. a rule row wrapping
badly) — the prompt framed its attention. Every vision review must include a
free-form fault-finding instruction (find anything unprofessional anywhere in
the UI), and every finding must be re-verified against the DOM (vision agents
misread small-pixel text: fullwidth ０ read as ASCII 0, "连字" read as "等字").

## r31 lesson: overlays must be captured OPEN + animation stacking traps

- **Screenshot coverage**: r30 screenshotted only the all-closed state, so
  vision could not see any overlay defect. Every round must capture: picker
  open (light + dark), search-filtered picker, a csel dropdown, the char
  popup, a help popover, and the fullscreen view. `_verify/probe.mjs` pins
  these as assertions.
- **`animation-fill-mode: both` retains the entrance effect forever**, which
  turns every section into a permanent stacking context — a popup's z-index
  then only competes inside that context, and the whole section is painted
  under its later siblings (the root cause of the "transparent list" bug).
  Entrance animations use `backwards`, never `both`, on any container that
  hosts a portal.
- **Exit transitions for `display:none` overlays**: `allow-discrete` +
  `@starting-style` transitions (pk: 0.17 s in / 0.13 s out). This requires
  the overlay node to survive re-renders — if render() rebuilds the overlay
  node, the exit transition dies with it. rFS was restructured to keep the
  skeleton and rebuild only the rows.
- **Node detachment during click dispatch**: a click handler that calls
  render() rebuilds the DOM and detaches e.target before the event bubbles to
  the document-level closer, where `closest()` returns null and the click is
  misread as an outside click. Guard with `e.target.isConnected`.
- **`stopPropagation` kills document-level outside-click closing**: the
  stopPropagation calls on cells, the fullscreen button, and the range button
  were removed; the closer uses a selector whitelist instead.
- **Popup positioning clamps to the app frame, not the viewport**: `fitPop()`
  — below the anchor first, flip above if it does not fit, cap the height
  with internal scrolling. Viewport-based clamping let the tall help popover
  paint past the rounded window frame onto the page background.
- **Playwright `locator.click` actionability errors are a detector**:
  "subtree intercepts pointer events" means the hit test is really blocked —
  the same thing the elementFromPoint audit reports. Investigate the
  stacking; do not bypass it.

# GUI main window = split-pane workspace — not a wizard flow, not a web page

The desktop client (Tauri 2) main window is a split-pane workspace: a fixed 260px left column (English font, CJK font, character scope, custom rules, synthesis settings), a right content area switching between character-map and real-world-scene modes, a persistent bottom stats bar, and a top bar carrying the brand, the font-pair tags, and the primary "synthesize" action. The layout was validated through 31 iteration rounds of a throwaway prototype; the prototype snapshot lives on the `prototype/gui` branch as a reference, not as implementation code to be reused.

## Considered options

- Wizard-style step flow (pick fonts → pick ranges → synthesize): rejected. Font merging is a workbench you tune repeatedly, not a linear flow. (A rejected wizard draft existed during prototyping.)
- Web page: rejected. The deliverable is a desktop client reading local font files directly, with no network dependency.
- Character map only, no scene preview: rejected. Terminal / code / document scenes are the key feedback loop for judging a merge; they are not optional.

## Implementation constraints carried from the prototype

The following details caused real defects during prototyping and were confirmed by the user; carry them into the implementation as-is:

- Every font-picker row renders its family name **in its own font** — a core feature, not decoration. The picker popup is an outer clipping layer plus an inner scroll area, with the "load local font file" footer outside the scroll area.
- Character-map pagination stays (1024 cells per page, uniform grid, goto-with-page-jump). Hierarchical categories and the "all" aggregate view coexist with it.
- Hover = neutral color (darker border + slight scale); the accent color belongs to selected/adjusted states only. Never conflate the two.
- Entrance animations use `fill-mode: backwards` everywhere — `both` leaves every section a permanent stacking context that traps the popup's z-index (the "transparent list" incident).
- Popups open and close via `allow-discrete` + `@starting-style` transitions, and the popup node must survive re-renders (rebuild rows only). Popup positioning clamps to the app window frame: below the anchor first, flip above if it does not fit, cap the height with internal scrolling otherwise.
- Stats numbers use tabular-nums. UI information never lives in hover-only tooltips — everything needs a click path.

/**
 * FontAlloy kit — character grid.
 *
 * GridCell and the uniform 1024-cells-per-page grid. Carried cell
 * vocabulary from the prototype:
 * - hover is NEUTRAL (border + recessed fill + 1.05 scale); the accent
 *   is reserved for the selected state (border + 1px ring + tint);
 * - adjusted cells carry the corner dot (.ov, paired with the 已调整
 *   legend); missing cells are dashed danger with the codepoint shown
 *   (round 20: a placeholder mapping keeps the font's own glyph under
 *   the frame, and an unmapped 图标-range cell carries no glyph at all);
 *   - the codepoint row (编码 mode) is tabular-nums 8.5px under the
 *   glyph; with it the cell switches to a column layout. The row ALWAYS
 *   renders in the UI font, never the cell's face — a winner or
 *   placeholder font may lack the label's digits/hex letters and turn
 *   "6E74" into "6■74" (repair round 2, f9); a missing cell shows the
 *   row unconditionally (it is the cell's only honest content);
 * - consumers with a separate details CURSOR (a keyboard/click focus
 *   distinct from the multi-selection) render it as `.cur` — an inner
 *   accent ring reading above the `.sel` selection tint.
 *
 * Data attributes: `cp` (codepoint label), `nofallback` (an unmapped
 * 图标-range cell) and every entry of `attrs` land on the cell's
 * dataset, so provenance (winner/via/kind) walks the DOM exactly like
 * the prototype's grid.
 *
 * Selection MODELS (drag-paint, shift-range) are app state and stay
 * with the consumer — the kit renders the props it is given.
 */

/**
 * The cell's effective-source vocabulary. `base` / `donor` render in
 * the winning font; `none` is a glyph the build lacks (dashed danger,
 * codepoint shown); `plain` is OUTSIDE the effective preview (no pick
 * at all yet) — a neutral cell in the plain preview stack, no miss
 * chrome (the grid cannot judge coverage before the build's fonts are
 * known).
 */
export type CellState = "base" | "donor" | "none" | "plain";

export interface GridCellData {
  /** The character (single codepoint). */
  ch: string;
  /** Effective source; "none" renders the missing style. */
  state: CellState;
  /**
   * The declaration EFFECTIVELY changed the supplier (round 8: the
   * resolved winner differs from the no-rule default) → the corner dot.
   */
  adjusted?: boolean;
  selected?: boolean;
  /**
   * The details CURSOR (a distinct accent-ring state consumers render on
   * top of the multi-selection; "selected" stays the selection state).
   */
  cursor?: boolean;
  /** CSS font-family stack for the glyph (the effective font). */
  fontFamily?: string;
  /**
   * Round 20: for a MISSING cell whose codepoint a picked font maps to
   * a suspected placeholder glyph — the cell KEEPS rendering the
   * font's own glyph (the box it really draws there) under the missing
   * style; the stack names that font.
   */
  placeholderFamily?: string;
  /**
   * Round 20: for a MISSING cell nothing maps — the 图标 ranges render
   * NO glyph at all (the codepoint row is the only content). The NF
   * icon area has no fixed meanings: a fallback face's tofu would lie.
   */
  noFallbackGlyph?: boolean;
  /** Codepoint label (e.g. "U+4E2D") exposed as data-cp for walkability. */
  cp?: string;
  /** Extra data attributes (e.g. winner/via/kind provenance). */
  attrs?: Record<string, string>;
}

export interface GridCellProps {
  data: GridCellData;
  /** Show the codepoint row under the glyph (编码 mode). */
  showCodepoint?: boolean;
  /** Interactive cells are buttons and open the char popover. */
  interactive?: boolean;
  onClick?(data: GridCellData, cell: HTMLElement): void;
}

export function formatCodepoint(ch: string): string {
  return ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * The UI font stack (tokens.css's body face). The codepoint label always
 * renders in it: the cell's own face — a winner font or a placeholder
 * mapping — may lack the label's digits and hex letters entirely, and a
 * label that follows the cell font stops reading as hex (f9: the audit
 * frames read "6E74" as "6■74", and the placeholder cells' "E000" as
 * "■000" — the box glyph standing in for the letter the font draws).
 */
const CP_LABEL_FONT = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';

export function gridCell(props: GridCellProps): HTMLElement {
  const { data } = props;
  const cell = document.createElement(
    props.interactive ? "button" : "span",
  ) as HTMLElement;
  if (props.interactive) (cell as HTMLButtonElement).type = "button";
  cell.dataset.ch = data.ch;
  if (data.cp) cell.dataset.cp = data.cp;
  if (data.attrs) {
    for (const [key, value] of Object.entries(data.attrs)) {
      cell.dataset[key] = value;
    }
  }
  cell.className =
    "kit-cell" +
    (data.adjusted ? " ov" : "") +
    (data.state === "none" ? " miss" : "") +
    (data.selected ? " sel" : "") +
    (data.cursor ? " cur" : "");
  if (data.state === "none") cell.setAttribute("aria-disabled", "true");

  const glyph = document.createElement("span");
  glyph.className = "ch";
  glyph.textContent = data.ch;
  cell.appendChild(glyph);

  // The codepoint row: 编码 mode shows it on every cell, and a missing
  // glyph ALWAYS shows it (prototype: `if(S.showCP||w==='none')`) — the
  // dashed cell is unrenderable ink, the codepoint is its only content.
  const showCp = props.showCodepoint || data.state === "none";
  if (showCp) {
    const cp = document.createElement("span");
    cp.className = "cp";
    // The row shows the bare hex (the prototype's compact form); the
    // cell's data-cp attribute keeps the full U+XXXX label. The label
    // pins to the UI font (f9): it must never inherit the cell's
    // winner/placeholder face, whatever that face covers.
    cp.textContent = (data.cp ?? formatCodepoint(data.ch)).replace(/^U\+/, "");
    cp.style.fontFamily = CP_LABEL_FONT;
    cell.classList.add("hascp");
    cell.appendChild(cp);
  }

  // Missing glyphs, three ways (round 20): a placeholder mapping keeps
  // the FONT'S OWN glyph under the missing frame; an unmapped 图标-range
  // codepoint renders NO glyph at all (no fallback tofu — the codepoint
  // row is the only content); every other missing glyph falls back to a
  // system reference face, clearly marked.
  if (data.state === "none") {
    if (data.placeholderFamily) {
      cell.style.fontFamily = data.placeholderFamily;
    } else if (data.noFallbackGlyph) {
      glyph.textContent = "";
      // f14: the emptied glyph area carries a visible "no glyph" mark —
      // a small dashed strike box over the cell — plus a data hook.
      // Without it the state is pixel-indistinguishable from any other
      // dashed missing cell (the audit's f7 pair read as zero diff).
      cell.dataset.nofallback = "true";
      const mark = document.createElement("span");
      mark.style.cssText =
        "position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);" +
        "width:12px;height:12px;border:1.5px dashed var(--dgr);" +
        "border-radius:3px;background:linear-gradient(to top right," +
        "transparent 44%,var(--dgr) 44%,var(--dgr) 56%,transparent 56%);" +
        "pointer-events:none;";
      cell.appendChild(mark);
    } else {
      cell.style.fontFamily = "'Microsoft YaHei',serif";
    }
  } else {
    cell.style.fontFamily = data.fontFamily ?? "";
  }

  // A SELECTED missing cell keeps an unmistakable ring (f14): the .sel
  // accent can drown under the dashed danger frame, so the selection is
  // restated inline — a 2px accent ring (and the accent border), with
  // the details-cursor insets kept when both states coincide.
  if (data.state === "none" && data.selected) {
    cell.style.borderColor = "var(--ac)";
    cell.style.boxShadow = data.cursor
      ? "0 0 0 2px var(--ac), inset 0 0 0 2px var(--sf), inset 0 0 0 3px var(--ac)"
      : "0 0 0 2px var(--ac)";
  }

  if (props.interactive && props.onClick) {
    cell.addEventListener("click", () => props.onClick!(data, cell));
  }
  return cell;
}

export interface CharGridProps {
  /** The current page's cells (already sliced to the page). */
  cells: readonly GridCellData[];
  showCodepoints?: boolean;
  /** Cell size in px (the prototype default: 40). */
  cellSize?: number;
  onCellClick?(data: GridCellData, cell: HTMLElement): void;
  /**
   * The grid's live COLUMN count (PRODUCT-EXTENSION for the responsive
   * page fill, round 5): reported after every render and on container
   * resizes, so the consumer can page in full rows (a page size that is
   * a multiple of the column count never leaves a partial last row on a
   * non-final page).
   */
  onColumns?(columns: number): void;
}

export interface CharGrid {
  readonly el: HTMLElement;
  /** Live cell lookup for locate/highlight flows. */
  cellAt(ch: string): HTMLElement | undefined;
  render(props: CharGridProps): void;
}

/** Page size ceiling — the uniform grid page (1024 cells). */
export const PAGE_SIZE = 1024;

export function mountCharGrid(host: HTMLElement): CharGrid {
  const wrap = document.createElement("div");
  wrap.className = "kit-gw";
  const grid = document.createElement("div");
  grid.className = "kit-grid";
  wrap.appendChild(grid);
  host.appendChild(wrap);

  let cells = new Map<string, HTMLElement>();
  let onColumns: ((columns: number) => void) | undefined;

  /** Report the laid-out column count (0 when the grid has no tracks). */
  const measureColumns = (): void => {
    const tracks = getComputedStyle(grid).gridTemplateColumns;
    const columns = tracks.trim() === "" || tracks === "none"
      ? 0
      : tracks.split(/\s+/).length;
    if (columns > 0) onColumns?.(columns);
  };

  // A resize (window, rail collapse, zoom) reflows the tracks; the page
  // fill must follow the new column count.
  const observer = new ResizeObserver(() => measureColumns());
  observer.observe(grid);

  const render = (props: CharGridProps): void => {
    onColumns = props.onColumns;
    grid.style.setProperty("--cell", `${props.cellSize ?? 40}px`);
    grid.innerHTML = "";
    cells = new Map();
    if (props.cells.length === 0) {
      const empty = document.createElement("div");
      empty.className = "kit-gempty";
      empty.textContent = "当前筛选下没有字符";
      grid.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const data of props.cells) {
      const cell = gridCell({
        data,
        showCodepoint: props.showCodepoints,
        interactive: Boolean(props.onCellClick),
        onClick: props.onCellClick,
      });
      cells.set(data.ch, cell);
      fragment.appendChild(cell);
    }
    grid.appendChild(fragment);
    // After the nodes land, the tracks exist and can be measured.
    measureColumns();
  };

  return {
    el: wrap,
    cellAt: (ch) => cells.get(ch),
    render,
  };
}

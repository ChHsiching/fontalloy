/**
 * FontAlloy kit — character grid.
 *
 * GridCell and the uniform 1024-cells-per-page grid. Carried cell
 * vocabulary from the prototype:
 * - hover is NEUTRAL (border + recessed fill + 1.05 scale); the accent
 *   is reserved for the selected state (border + 1px ring + tint);
 * - adjusted cells carry the corner dot (.ov, paired with the 已调整
 *   legend); missing cells are dashed danger with the codepoint shown;
 *   - the codepoint row (编码 mode) is tabular-nums 8.5px under the
 *   glyph; with it the cell switches to a column layout;
 * - consumers with a separate details CURSOR (a keyboard/click focus
 *   distinct from the multi-selection) render it as `.cur` — an inner
 *   accent ring reading above the `.sel` selection tint.
 *
 * Data attributes: `cp` (codepoint label) and every entry of `attrs`
 * land on the cell's dataset, so provenance (winner/via/kind) walks the
 * DOM exactly like the prototype's grid.
 *
 * Selection MODELS (drag-paint, shift-range) are app state and stay
 * with the consumer — the kit renders the props it is given.
 */

/**
 * The cell's effective-source vocabulary. `base` / `donor` render in
 * the winning font; `none` is a glyph the build lacks (dashed danger,
 * codepoint shown); `plain` is OUTSIDE the effective preview (no pick
 * pair yet) — a neutral cell in the plain preview stack, no miss chrome
 * (the grid cannot judge coverage before the build's fonts are known).
 */
export type CellState = "base" | "donor" | "none" | "plain";

export interface GridCellData {
  /** The character (single codepoint). */
  ch: string;
  /** Effective source; "none" renders the missing style. */
  state: CellState;
  /** Effective value differs from the default → the corner dot. */
  adjusted?: boolean;
  selected?: boolean;
  /**
   * The details CURSOR (a distinct accent-ring state consumers render on
   * top of the multi-selection; "selected" stays the selection state).
   */
  cursor?: boolean;
  /** CSS font-family stack for the glyph (the effective font). */
  fontFamily?: string;
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

  const showCp =
    props.showCodepoint || (data.state === "none" && data.cp === undefined);
  if (showCp) {
    const cp = document.createElement("span");
    cp.className = "cp";
    cp.textContent = data.cp ?? formatCodepoint(data.ch);
    cell.classList.add("hascp");
    cell.appendChild(cp);
  }

  // Missing glyphs fall back to a system reference face, clearly marked.
  cell.style.fontFamily =
    data.state === "none"
      ? "'Microsoft YaHei',serif"
      : (data.fontFamily ?? "");

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
}

export interface CharGrid {
  readonly el: HTMLElement;
  /** Live cell lookup for locate/highlight flows. */
  cellAt(ch: string): HTMLElement | undefined;
  render(props: CharGridProps): void;
}

/** Page size — the uniform grid page (1024 cells). */
export const PAGE_SIZE = 1024;

export function mountCharGrid(host: HTMLElement): CharGrid {
  const wrap = document.createElement("div");
  wrap.className = "kit-gw";
  const grid = document.createElement("div");
  grid.className = "kit-grid";
  wrap.appendChild(grid);
  host.appendChild(wrap);

  let cells = new Map<string, HTMLElement>();

  const render = (props: CharGridProps): void => {
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
  };

  return {
    el: wrap,
    cellAt: (ch) => cells.get(ch),
    render,
  };
}

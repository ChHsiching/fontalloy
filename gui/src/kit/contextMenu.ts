/**
 * FontAlloy kit — ContextMenu.
 *
 * PRODUCT-EXTENSION (round 18, owner item 1): the webview's DEFAULT
 * browser context menu is replaced EVERYWHERE by this kit-themed menu —
 * never merely hidden — carrying exactly three real buttons: 复制 /
 * 剪切 / 粘贴. Enablement is contextual: 复制 needs a selection (the
 * document selection, or one inside the editable under the pointer);
 * 剪切 additionally needs an editable target; 粘贴 needs an editable
 * target AND a readable clipboard (a webview whose clipboard API is
 * missing or denied degrades to a disabled button — never an error).
 * An empty context still SHOWS the menu with all three disabled.
 *
 * Chrome follows the kit's overlay language: a persistent node on
 * <body> (immune to rail overflow and entrance stacking contexts),
 * `.kit-pop`'s visibility/opacity/scale transition BOTH ways, and
 * positioning through the shared `fitPopup` clamping discipline — a
 * zero-size anchor at the pointer means below → flip above → cap,
 * never crossing the `[data-kit-frame]` frame. The menu acts on the
 * selection CAPTURED AT OPEN (restored before the command runs): a
 * native context menu freezes its target the same way, and the menu
 * button's own focus/pointer churn in between cannot eat the action.
 */

import { fitPopup } from "./position";

/** An element paste/cut can act on (a textual field or contenteditable). */
type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** Input types whose text copy/cut/paste is meaningful. */
const TEXTUAL_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "tel",
  "password",
  "email",
  "number",
]);

/**
 * The editable under a context-menu target, if any. A right-click on a
 * contenteditable host targets its inner text nodes — `isContentEditable`
 * resolves those to the host; input/textarea are their own targets.
 */
function editableFor(target: EventTarget | null): Editable | null {
  if (target instanceof HTMLInputElement) {
    return TEXTUAL_INPUT_TYPES.has(target.type.toLowerCase()) ? target : null;
  }
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLElement && target.isContentEditable) return target;
  return null;
}

/** The selection context captured when the menu opened. */
interface CapturedContext {
  editable: Editable | null;
  /** Non-collapsed DOCUMENT selection at open (cloned range). */
  docRange: Range | null;
  /**
   * An input/textarea's selection AT OPEN — always captured (collapsed
   * means caret): the right-click itself repositions a collapsed caret
   * and the menu's own focus churn can blur the field, so paste reads
   * THIS, not the live field, exactly like a native menu acting on the
   * context it was summoned with.
   */
  fieldRange: { start: number; end: number } | null;
  /** Whether the field selection at open was non-collapsed. */
  fieldSelected: boolean;
  /** A contenteditable's selection at open (cloned range, any state). */
  editRange: Range | null;
  /** Whether the contenteditable selection at open was non-collapsed. */
  editSelected: boolean;
}

/**
 * Whether the clipboard can be READ in this environment. `readText` is
 * dead in some webviews (Linux webkit2gtk) and permission-denied in
 * locked-down browsers — both degrade 粘贴 to disabled. Probed once at
 * mount through the Permissions API (never by reading the clipboard,
 * which could pop a prompt on a mere right-click), kept live via
 * onchange.
 */
let pasteAllowed =
  typeof navigator !== "undefined" &&
  typeof navigator.clipboard?.readText === "function";

function probePastePermission(): void {
  if (!("permissions" in navigator)) return;
  navigator.permissions
    .query({ name: "clipboard-read" as PermissionName })
    .then((status) => {
      const read = (): void => {
        pasteAllowed =
          status.state !== "denied" &&
          typeof navigator.clipboard?.readText === "function";
      };
      read();
      status.onchange = read;
    })
    .catch(() => {
      // The Permissions API does not know clipboard-read here — trust
      // the API-shape verdict from above.
    });
}

/** Write `text` to the clipboard; resolves false when nothing worked. */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function captureContext(target: EventTarget | null): CapturedContext {
  const editable = editableFor(target);
  let docRange: Range | null = null;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    docRange = sel.getRangeAt(0).cloneRange();
  }
  let fieldRange: CapturedContext["fieldRange"] = null;
  let fieldSelected = false;
  let editRange: Range | null = null;
  let editSelected = false;
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart;
    const end = editable.selectionEnd;
    if (start !== null && end !== null) {
      fieldRange = { start, end };
      fieldSelected = start !== end;
    }
  } else if (editable && sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (editable.contains(range.commonAncestorContainer)) {
      editRange = range.cloneRange();
      editSelected = !editRange.collapsed;
    }
  }
  return {
    editable,
    docRange,
    fieldRange,
    fieldSelected,
    editRange,
    editSelected,
  };
}

/** Restore a captured range as the live document selection. */
function restoreRange(range: Range): void {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Fire the input/change pair a programmatic field edit owes the app. */
function notifyFieldEdit(el: Editable): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The text of the captured selection (field > contenteditable > document). */
function capturedText(ctx: CapturedContext): string {
  if (
    ctx.fieldSelected &&
    ctx.fieldRange &&
    (ctx.editable instanceof HTMLInputElement ||
      ctx.editable instanceof HTMLTextAreaElement)
  ) {
    return ctx.editable.value.slice(ctx.fieldRange.start, ctx.fieldRange.end);
  }
  if (ctx.editSelected && ctx.editRange) return ctx.editRange.toString();
  if (ctx.docRange) return ctx.docRange.toString();
  return "";
}

/**
 * Copy the captured selection. execCommand('copy') copies the ACTIVE
 * selection under the click's user activation (the Chromium webview
 * path); the Selection API + clipboard.writeText pair is the fallback.
 */
async function copyCaptured(ctx: CapturedContext): Promise<void> {
  const editable = ctx.editable;
  if (
    editable instanceof HTMLInputElement ||
    editable instanceof HTMLTextAreaElement
  ) {
    if (ctx.fieldSelected && ctx.fieldRange) {
      editable.focus();
      editable.setSelectionRange(ctx.fieldRange.start, ctx.fieldRange.end);
      if (document.execCommand("copy")) return;
    }
  } else if (editable && ctx.editSelected && ctx.editRange) {
    editable.focus();
    restoreRange(ctx.editRange);
    if (document.execCommand("copy")) return;
  } else if (ctx.docRange) {
    restoreRange(ctx.docRange);
    if (document.execCommand("copy")) return;
  }
  const text = capturedText(ctx);
  if (text !== "") await writeToClipboard(text);
}

/** Cut the captured selection out of the editable under the pointer. */
async function cutCaptured(ctx: CapturedContext): Promise<void> {
  const editable = ctx.editable;
  if (!editable) return;
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    if (!ctx.fieldSelected || !ctx.fieldRange) return;
    const { start, end } = ctx.fieldRange;
    editable.focus();
    editable.setSelectionRange(start, end);
    if (!document.execCommand("cut")) {
      const text = editable.value.slice(start, end);
      if (!(await writeToClipboard(text))) return;
      editable.setRangeText("", start, end, "end");
      notifyFieldEdit(editable);
    }
    return;
  }
  // contenteditable — its own selection only; a selection living
  // elsewhere in the document is copy's business, not cut's.
  if (!ctx.editSelected || !ctx.editRange) return;
  editable.focus();
  restoreRange(ctx.editRange);
  if (!document.execCommand("cut")) {
    const text = ctx.editRange.toString();
    if (!(await writeToClipboard(text))) return;
    ctx.editRange.deleteContents();
    notifyFieldEdit(editable);
  }
}

/**
 * Paste into the editable at the CARET CAPTURED AT OPEN. execCommand
 * ('paste') is dead in Chromium — the async Clipboard API is the only
 * path, so a rejected read simply does nothing (the button is already
 * disabled when the rejection was knowable up front). A non-collapsed
 * captured selection is REPLACED, exactly like a native paste.
 */
async function pasteInto(ctx: CapturedContext): Promise<void> {
  const editable = ctx.editable;
  if (!editable) return;
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const caret = ctx.fieldRange ?? {
      start: editable.value.length,
      end: editable.value.length,
    };
    editable.focus();
    editable.setSelectionRange(caret.start, caret.end);
    editable.setRangeText(text, caret.start, caret.end, "end");
    notifyFieldEdit(editable);
    return;
  }
  editable.focus();
  if (ctx.editRange) restoreRange(ctx.editRange);
  // insertText keeps the host's undo stack and fires a native input.
  if (!document.execCommand("insertText", false, text)) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editable.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.setStartAfter(range.endContainer);
        range.collapse(true);
        restoreRange(range);
        notifyFieldEdit(editable);
      }
    }
  }
}

export interface ContextMenu {
  /** The menu node (a persistent child of <body>). */
  readonly el: HTMLElement;
  /** Open at a viewport point for a target (moves when already open). */
  openAt(x: number, y: number, target: EventTarget | null): void;
  close(): void;
  /** Tear the component down: close and remove the node + listeners. */
  destroy(): void;
}

interface ContextMenuItem {
  action: "copy" | "cut" | "paste";
  label: string;
}

const ITEMS: readonly ContextMenuItem[] = [
  { action: "copy", label: "复制" },
  { action: "cut", label: "剪切" },
  { action: "paste", label: "粘贴" },
];

export function mountContextMenu(): ContextMenu {
  probePastePermission();

  const el = document.createElement("div");
  el.className = "kit-ctx";
  el.dataset.contextMenu = "";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "编辑菜单");
  el.tabIndex = -1; // focusable so Escape works with nothing enabled
  document.body.appendChild(el);

  const buttons = new Map<ContextMenuItem["action"], HTMLButtonElement>();
  for (const item of ITEMS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kit-ctx-item";
    button.dataset.role = `ctx-${item.action}`;
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", item.label);
    button.textContent = item.label;
    buttons.set(item.action, button);
    el.appendChild(button);
  }

  // The menu acts on the context captured at open; clicking runs the
  // action and closes (native context-menu semantics).
  let open = false;
  let ctx: CapturedContext = {
    editable: null,
    docRange: null,
    fieldRange: null,
    fieldSelected: false,
    editRange: null,
    editSelected: false,
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    el.classList.remove("open");
  };

  const run = (action: ContextMenuItem["action"]): void => {
    const captured = ctx;
    close();
    if (action === "copy") void copyCaptured(captured);
    else if (action === "cut") void cutCaptured(captured);
    else void pasteInto(captured);
  };

  for (const [action, button] of buttons) {
    button.addEventListener("click", () => run(action));
  }

  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (!target.isConnected) return;
    if (el.contains(target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      // One layer per press (round 7 discipline): this Escape closes
      // the context menu ONLY.
      e.stopImmediatePropagation();
      close();
    }
  });
  // The menu anchors to a pointer POINT, not an element — a resized
  // frame cannot re-anchor it, so it closes instead of drifting.
  window.addEventListener("resize", close);

  return {
    el,
    openAt(x: number, y: number, target: EventTarget | null): void {
      ctx = captureContext(target);
      const hasEditableSelection = ctx.fieldSelected || ctx.editSelected;
      buttons.get("copy")!.disabled = !(hasEditableSelection || ctx.docRange);
      buttons.get("cut")!.disabled = !(ctx.editable && hasEditableSelection);
      buttons.get("paste")!.disabled = !(ctx.editable && pasteAllowed);
      if (!open) {
        open = true;
        el.classList.add("open");
      }
      // fitPopup's clamping with a zero-size anchor at the pointer:
      // below → flip above → cap, inside the kit frame.
      fitPopup(el, new DOMRect(x, y, 0, 0));
      // Menu focus: the first enabled item, else the menu itself.
      const firstEnabled = [...buttons.values()].find((b) => !b.disabled);
      (firstEnabled ?? el).focus();
    },
    close,
    destroy(): void {
      close();
      el.remove();
    },
  };
}

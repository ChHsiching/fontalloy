/**
 * FontAlloy kit — AppSelect.
 *
 * The prototype's custom dropdown (mkSelect), rebuilt typed and
 * prop-driven. Carried behavior:
 *
 * - a bordered pill with a painted chevron (appearance-free, styled by
 *   the design language instead of the OS);
 * - open state = accent border + soft focus glow (the "csel glow");
 * - open/close animate through `display` with allow-discrete +
 *   @starting-style (the popup node is part of the component and only
 *   the option rows ever rebuild — node persistence);
 * - keyboard: Enter/Space/ArrowDown/ArrowUp open, arrows move and
 *   commit, Escape closes; outside click closes;
 * - opening one closes every other open kit select.
 */

export interface AppSelectOption {
  value: string;
  label: string;
}

export interface AppSelectProps {
  /** aria-label for the trigger button. */
  label: string;
  value: string;
  options: readonly AppSelectOption[];
  /** Fires on pick and on keyboard arrow moves (prototype parity). */
  onChange?(value: string): void;
}

export interface AppSelect {
  /** The component root (.kit-cselw) — append it anywhere. */
  readonly el: HTMLElement;
  get value(): string;
  /** Set the value without firing onChange. */
  set value(next: string);
  /** Replace the option list (rows rebuild; nodes survive). */
  setOptions(options: readonly AppSelectOption[], value?: string): void;
  open(): void;
  close(): void;
  /**
   * Tear the component down: close, remove the element, and detach the
   * document-level listeners. Call before rebuilding a region that owns
   * the select (the rule rows) — document listeners per
   * instance would otherwise accumulate as inert leaks.
   */
  destroy(): void;
}

/** Every live select — opening one closes the others. */
const openSelects = new Set<HTMLElement>();

export function mountAppSelect(props: AppSelectProps): AppSelect {
  const root = document.createElement("div");
  root.className = "kit-cselw";
  // Stage-3 extension: every document/window listener rides one abort
  // signal so destroy() detaches them all.
  const listeners = new AbortController();
  const { signal } = listeners;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "kit-csel";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (props.label) trigger.setAttribute("aria-label", props.label);

  const list = document.createElement("div");
  list.className = "kit-csel-pk";
  list.setAttribute("role", "listbox");
  if (props.label) list.setAttribute("aria-label", props.label);

  root.append(trigger, list);

  let options = [...props.options];
  let idx = Math.max(
    0,
    options.findIndex((o) => o.value === props.value),
  );
  let open = false;

  const current = (): AppSelectOption | undefined => options[idx];

  const drawTrigger = (): void => {
    trigger.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = current()?.label ?? "";
    trigger.appendChild(span);
  };

  const drawRows = (): void => {
    list.innerHTML = "";
    options.forEach((option, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "kit-cso";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === idx));
      row.dataset.value = option.value;
      row.textContent = option.label;
      list.appendChild(row);
    });
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    openSelects.delete(root);
    root.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
  };

  const openList = (): void => {
    if (open) return;
    for (const other of [...openSelects]) {
      other.dispatchEvent(new CustomEvent("kit-select-close"));
    }
    open = true;
    openSelects.add(root);
    root.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
  };

  const commit = (next: number, fire: boolean): void => {
    idx = next;
    drawTrigger();
    drawRows();
    if (fire) props.onChange?.(current()?.value ?? "");
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) close();
    else openList();
  });

  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".kit-cso");
    if (!row) return;
    e.stopPropagation();
    commit(options.findIndex((o) => o.value === row.dataset.value), true);
    close();
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (
      !open &&
      (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp")
    ) {
      e.preventDefault();
      openList();
      return;
    }
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      commit(
        (idx + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length,
        true,
      );
    }
  });

  // Cross-select coordination + outside close (pointerdown, with the
  // still-connected guard the prototype learned the hard way).
  root.addEventListener("kit-select-close", close);
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!open) return;
      const target = e.target as Node;
      if (!target.isConnected || root.contains(target)) return;
      close();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && open) close();
    },
    { signal },
  );

  drawTrigger();
  drawRows();

  return {
    el: root,
    get value() {
      return current()?.value ?? "";
    },
    set value(next: string) {
      idx = Math.max(
        0,
        options.findIndex((o) => o.value === next),
      );
      drawTrigger();
      drawRows();
    },
    setOptions(next, value) {
      options = [...next];
      idx = Math.max(
        0,
        options.findIndex((o) => o.value === (value ?? current()?.value)),
      );
      drawTrigger();
      drawRows();
    },
    open: openList,
    close,
    destroy() {
      close();
      openSelects.delete(root);
      listeners.abort();
      root.remove();
    },
  };
}

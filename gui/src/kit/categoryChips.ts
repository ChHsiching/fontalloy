/**
 * FontAlloy kit — CategoryChips.
 *
 * The prototype's horizontal two-level category bar: a first row of
 * group toggles (icon + label + count, with 全部 and 缺失 as special
 * groups — 缺失 in the danger color) and a second row of block chips
 * under the active group, led by the group's 全部 aggregate. Hover
 * lifts non-active chips by 1px; the active chip is accent-tinted and
 * semibold.
 */

import { icon, type IconName } from "./icons";

export interface CategoryGroup {
  id: string;
  label: string;
  count: number;
  icon?: IconName;
  /** Danger styling (the 缺失 group). */
  danger?: boolean;
}

export interface CategoryBlock {
  id: string;
  label: string;
  count: number;
  icon?: IconName;
}

export interface CategoryChipsProps {
  /** Group row; include the 全数/缺失 aggregates in here. */
  groups: readonly CategoryGroup[];
  /** Block row for the ACTIVE group; empty hides the second row. */
  blocks: readonly CategoryBlock[];
  /** Active group id, or null when the unfiltered view is on. */
  activeGroupId: string | null;
  /** Active block id (a block, or `g:<gid>` for the group aggregate). */
  activeBlockId: string;
  /** Group click; null means the 全部 aggregate was picked. */
  onGroup(id: string | null): void;
  onBlock(id: string): void;
}

export interface CategoryChips {
  readonly el: HTMLElement;
  render(props: CategoryChipsProps): void;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

export function mountCategoryChips(
  host: HTMLElement,
  initial: CategoryChipsProps,
): CategoryChips {
  const el = document.createElement("div");
  el.className = "kit-catbar";
  host.appendChild(el);

  let props: CategoryChipsProps = initial;

  const render = (): void => {
    el.innerHTML = "";
    const l1 = document.createElement("div");
    l1.className = "kit-cat-l1";
    for (const group of props.groups) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "kit-cat-g" +
        (props.activeGroupId === group.id ? " on" : "") +
        (group.danger ? " miss" : "");
      btn.dataset.group = group.id;
      if (group.icon) btn.innerHTML = icon(group.icon);
      const label = document.createElement("span");
      label.textContent = group.label;
      btn.appendChild(label);
      const n = document.createElement("span");
      n.className = "n kit-num";
      n.textContent = fmt(group.count);
      btn.appendChild(n);
      btn.addEventListener("click", () => {
        // Clicking the active group keeps it (prototype parity: the
        // 全部 chip is the route back to the unfiltered view).
        props.onGroup(group.id);
      });
      l1.appendChild(btn);
    }
    el.appendChild(l1);

    if (props.blocks.length > 0) {
      const l2 = document.createElement("div");
      l2.className = "kit-cat-l2";
      for (const block of props.blocks) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "kit-cat-s" + (props.activeBlockId === block.id ? " on" : "");
        btn.dataset.block = block.id;
        if (block.icon) btn.innerHTML = icon(block.icon);
        const label = document.createElement("span");
        label.textContent = block.label;
        btn.appendChild(label);
        const n = document.createElement("span");
        n.className = "n kit-num";
        n.textContent = fmt(block.count);
        btn.appendChild(n);
        btn.addEventListener("click", () => props.onBlock(block.id));
        l2.appendChild(btn);
      }
      el.appendChild(l2);
    }
  };

  render();

  return {
    el,
    render(next) {
      props = next;
      render();
    },
  };
}

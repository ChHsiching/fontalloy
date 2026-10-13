/**
 * FontAlloy kit — StatusBar.
 *
 * The color-coded coverage strip from the prototype: 字符 (total),
 * 英文 (accent dot), 中文 (accent-strong dot), 已调整, 缺失 (danger
 * dot), and the right-aligned 覆盖 percentage in the accent color.
 * Every number renders in tabular numerals; a changed value pops
 * (scale bounce) once.
 */

export interface StatusBarStats {
  total: number;
  en: number;
  cjk: number;
  adjusted: number;
  missing: number;
  /** Coverage percentage, already formatted (e.g. "99.98"). */
  coveragePct: string;
}

export interface StatusBar {
  readonly el: HTMLElement;
  render(stats: StatusBarStats): void;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

function counter(
  label: string,
  key: string,
  dotColor?: string,
): { wrap: HTMLElement; value: HTMLElement } {
  const wrap = document.createElement("span");
  wrap.className = "kit-c";
  if (dotColor) {
    const dot = document.createElement("i");
    dot.style.background = dotColor;
    wrap.appendChild(dot);
  }
  const value = document.createElement("b");
  value.className = "kit-num";
  value.dataset.stat = key;
  wrap.append(value, document.createTextNode(label));
  return { wrap, value };
}

export function mountStatusBar(host: HTMLElement): StatusBar {
  const el = document.createElement("footer");
  el.className = "kit-stat";
  host.appendChild(el);

  const total = counter("字符", "total");
  const en = counter("英文", "en", "var(--ac)");
  const cjk = counter("中文", "cjk", "var(--acs)");
  const adjusted = counter("已调整", "adjusted");
  const missing = counter("缺失", "missing", "var(--dgr)");
  const cov = document.createElement("span");
  cov.className = "kit-cov";
  const covLabel = document.createElement("span");
  covLabel.className = "kit-cov-label";
  covLabel.textContent = "覆盖";
  cov.append(covLabel);
  const covValue = document.createElement("b");
  covValue.className = "kit-num";
  covValue.dataset.stat = "coverage";
  cov.append(covValue, document.createTextNode("%"));

  el.append(
    total.wrap,
    en.wrap,
    cjk.wrap,
    adjusted.wrap,
    missing.wrap,
    cov,
  );

  let previous: Record<string, string> | null = null;

  const render = (stats: StatusBarStats): void => {
    const values: Record<string, string> = {
      total: fmt(stats.total),
      en: fmt(stats.en),
      cjk: fmt(stats.cjk),
      adjusted: fmt(stats.adjusted),
      missing: fmt(stats.missing),
      coverage: stats.coveragePct,
    };
    for (const [key, text] of Object.entries(values)) {
      const node = el.querySelector<HTMLElement>(`[data-stat="${key}"]`);
      if (!node) continue;
      if (previous && previous[key] !== text) {
        node.textContent = text;
        node.classList.add("pop");
        setTimeout(() => node.classList.remove("pop"), 260);
      } else {
        node.textContent = text;
      }
    }
    previous = values;
  };

  return { el, render };
}

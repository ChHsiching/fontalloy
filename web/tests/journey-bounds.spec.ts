import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The J11 journey's wait discipline, checked DRY (spec #25's final
 * batch): every locator wait in web/tests/journey.spec.ts carries an
 * EXPLICIT timeout. The batch's 40-minute stall came from pick-surface
 * waits that rode implicit defaults — a missing chip (the stale-manifest
 * symptom: variant_cuts collapses MapleMono NF/NF-CN into one cut) must
 * fail the journey in minutes with a message, never hang. This spec
 * reads the journey's SOURCE and fails on any wait-family call whose
 * argument list lacks `timeout`, so a future edit cannot quietly drop
 * the bound. No browser is involved.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Calls whose argument list must name a `timeout`. */
const WAIT_CALLS = [
  "toBeVisible(",
  "toBeHidden(",
  "toHaveText(",
  "toHaveAttribute(",
  "toHaveClass(",
  "toHaveCount(",
  "toContainText(",
  "scrollIntoViewIfNeeded(",
  "waitForEvent(",
  ".waitFor(",
  "expect.poll(",
] as const;

/** The balanced-paren argument text of the call starting at `open`. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

test("every locator wait in the J11 journey carries an explicit timeout", async () => {
  const source = await readFile(join(HERE, "journey.spec.ts"), "utf8");
  const unbounded: string[] = [];
  for (const marker of WAIT_CALLS) {
    let at = source.indexOf(marker);
    while (at !== -1) {
      const open = source.indexOf("(", at);
      const args = callArguments(source, open);
      if (!/\btimeout\b/.test(args)) {
        const line = source.slice(0, at).split("\n").length;
        unbounded.push(`line ${line}: ${marker}… without a timeout`);
      }
      at = source.indexOf(marker, at + marker.length);
    }
  }
  expect(
    unbounded,
    "the journey's wait-family calls must all carry an explicit timeout " +
      "(a missing chip must fail in minutes, never ride the journey " +
      "timeout):\n  " +
      unbounded.join("\n  "),
  ).toEqual([]);
});

test("the pick path bounds its chip/row waits through awaitPickSurface", async () => {
  const source = await readFile(join(HERE, "journey.spec.ts"), "utf8");
  expect(
    source,
    "the journey defines the bounded pick-surface wait helper",
  ).toContain("async function awaitPickSurface(");
  expect(source).toContain("const PICK_WAIT_MS =");
  // The J11.3 chip itself is awaited through the bounded helper (the
  // stale-manifest canary), not clicked blind.
  const chipWait = source.indexOf("awaitPickSurface(");
  const nfCn = source.indexOf("nfCnChip");
  expect(chipWait).toBeGreaterThan(-1);
  expect(nfCn).toBeGreaterThan(-1);
  const untilClick = source.slice(
    0,
    source.indexOf("await rawClick(page, nfCnChip);"),
  );
  expect(untilClick).toMatch(
    /await awaitPickSurface\(\r?\n\s+nfCnChip,/,
  );
});

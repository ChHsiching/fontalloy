import { expect, test, type Page, type Request } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoJsErrors,
  collectJsErrors,
  openFontPicker,
  pickCatalogFamily,
  pickSelectOption,
  pointerClick,
  waitForCatalogReady,
  waitForFontsReady,
} from "./helpers";
import { PREVIEW_ORIGIN, REPO_ROOT, startServe, type ServeHandle } from "./serve";

/**
 * The REAL local catalog on the static target — SERVE-backed (ticket
 * #30/#33: the page's catalog business died; `fontalloy serve` owns the
 * release sync, the scanning, and the byte streaming). The suite boots
 * ONE real serve per worker whose release origin is the preview
 * server's own /dev-catalog (the same dev catalog the gui dev server
 * serves — the webServer env restricts it to the committed manifest
 * SUBSET, so the fixture scale stays ~1.6 GB) and drives the built
 * page at it through ?serve=, exactly the way a consumer runs the
 * WebApp with a local serve. Every row/name/star expectation DERIVES
 * from the release document that origin actually serves plus the app's
 * own curated display data — never a hardcoded catalog census.
 *
 * Catalog-family REFERENCES (the live submission's recipe slots) the
 * serve resolves against a FETCHED layout (the J11 convention): the
 * refreshed scratch `<repo>/.scratch/run-assets` first — materialize
 * it with `uv run python scripts/refresh_run_assets.py --source
 * ../fontalloy-run/assets --output .scratch/run-assets` — else the
 * FONTALLOY_RUN_ASSETS layout. Without a layout the listing specs
 * still pass; the live-submission spec's resolve/build cannot.
 */

test.setTimeout(240_000);

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The suite's serve catalog directory (the J11 pattern): a stable
 * gitignored scratch, so the first run pays the zip sync and every
 * later run boots warm.
 */
async function catalogDir(): Promise<string> {
  const dir = join(REPO_ROOT, ".scratch", "web-catalog");
  await mkdir(dir, { recursive: true });
  return dir;
}

let serve: ServeHandle | null = null;

/** The fetched layout's manifest, when one exists (see the header). */
function fetchLayoutManifest(): string | undefined {
  const scratch = join(REPO_ROOT, ".scratch", "run-assets", "fonts.manifest.json");
  if (existsSync(scratch)) return scratch;
  const env = process.env.FONTALLOY_RUN_ASSETS;
  if (env !== undefined) return join(env, "fonts.manifest.json");
  return undefined;
}

test.beforeAll(async () => {
  serve = await startServe({
    allowOrigin: PREVIEW_ORIGIN,
    catalogReleaseOrigin: `${PREVIEW_ORIGIN}/dev-catalog`,
    catalogDir: await catalogDir(),
    ...(fetchLayoutManifest() !== undefined
      ? { manifest: fetchLayoutManifest() }
      : {}),
  });
});

test.afterAll(async () => {
  await serve?.stop();
  serve = null;
});

/** Load the built page against the suite's catalog-carrying serve. */
async function loadCatalogPage(page: Page): Promise<void> {
  await page.goto(`/?serve=${encodeURIComponent(serve!.baseUrl)}`);
  await waitForFontsReady(page);
  await waitForCatalogReady(page);
}

/** The release document the preview origin serves (the subset truth). */
async function releaseFamilies(page: Page): Promise<string[]> {
  const release = await page.evaluate(async () => {
    const res = await fetch("/dev-catalog/catalog-release.json");
    return (await res.json()) as { families: Array<{ family: string }> };
  });
  return [...new Set(release.families.map((f) => f.family))];
}

/** The app's own curated display data (front pins, slots, groups). */
async function curated() {
  return JSON.parse(
    await readFile(resolve(HERE, "../../gui/src/data/curated-meta.json"), "utf8"),
  ) as {
    front: { en: string[]; cjk: string[] };
    slots?: { cjk?: string[] };
    groups?: Record<string, string[]>;
    families: Record<string, { stars?: number; trait?: string }>;
  };
}

test("the real catalog lists real families with real meta", async ({ page }) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);
  await loadCatalogPage(page);

  const families = await releaseFamilies(page);
  const meta = await curated();
  const cjkSide = new Set(meta.slots?.cjk ?? []);
  // Group members collapse onto their group's display row.
  const groups = meta.groups ?? {};
  const groupOf = new Map(
    Object.entries(groups).flatMap(([id, members]) =>
      members.map((member) => [member, id] as const),
    ),
  );

  const popup = await openFontPicker(page, "en");
  const rows = popup.locator(".kit-fp");
  // The EN slot lists the manifest's coding families the origin serves
  // (subset − CJK-side ids − SymbolsOnly), the curated FRONT first —
  // JetBrainsMono is the front's lead; 0xProto follows manifest order.
  // Rows read the faces' OWN name-table names (round 9), pinned here
  // as the committed subset fixture's stable identity.
  const enFamilies = families.filter(
    (id) => !cjkSide.has(id) && id !== "NerdFontsSymbolsOnly",
  );
  await expect(rows).toHaveCount(enFamilies.length);
  const frontPinned = new Set(["JetBrainsMono"]);
  const expectedEnRows = [
    ...meta.front.en.filter((id) => enFamilies.includes(id)),
    ...enFamilies.filter((id) => !meta.front.en.includes(id)),
  ];
  const expectedEnNames = expectedEnRows.map((id) =>
    frontPinned.has(id) ? "JetBrainsMono Nerd Font" : "0xProto Nerd Font",
  );
  expect((await rows.allTextContents()).slice(0, expectedEnNames.length)).toEqual(
    expectedEnNames.map((name) => expect.stringContaining(name)),
  );
  // The pinned front's lead row reads the face's OWN name-table name
  // (round 9) with its curated meta: license + trait + stars seed.
  const jb = rows.filter({ hasText: "JetBrainsMono Nerd Font" });
  await expect(jb).toHaveCount(1);
  await expect(jb).toContainText("OFL");
  await expect(jb).toContainText("连字");
  await expect(rows.filter({ hasText: "0xProto Nerd Font" })).toContainText(
    "源码可读性优先",
  );
  // The EN slot never lists the CJK-side families (separate catalogs).
  await expect(rows.filter({ hasText: "LXGW WenKai" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Noto Sans SC" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The CJK slot lists exactly the CJK-side families the origin serves
  // (group members collapsed), the prototype's LD front order first —
  // Maple's default cut, the WenKai group base, Noto's display name.
  const cjkDisplayIds = [
    ...new Set(
      families
        .filter((id) => cjkSide.has(id))
        .map((id) => groupOf.get(id) ?? id),
    ),
  ];
  const expectedCjkFront = [
    ...meta.front.cjk.filter((id) => cjkDisplayIds.includes(id)),
    ...cjkDisplayIds.filter((id) => !meta.front.cjk.includes(id)),
  ];
  const cjkRowNames: Record<string, string> = {
    MapleMono: "Maple Mono NF",
    LXGWWenKai: "LXGW WenKai",
    NotoSansSC: "Noto Sans SC",
  };
  const cjkPopup = await openFontPicker(page, "cjk");
  await expect(cjkPopup.locator(".kit-fp")).toHaveCount(
    cjkDisplayIds.length,
  );
  const cjkTexts = await cjkPopup.locator(".kit-fp").allTextContents();
  expect(cjkTexts.slice(0, expectedCjkFront.length)).toEqual(
    expectedCjkFront.map(
      (id) => expect.stringContaining(cjkRowNames[id] ?? id),
    ),
  );
  // Exactly ONE WenKai GROUP row: the curated group collapses the
  // manifest's WenKai members onto one chip row.
  expect(
    cjkTexts.filter(
      (row) => row.startsWith("LXGW WenKai") && !row.startsWith("LXGW WenKai "),
    ),
  ).toHaveLength(1);
  // The curated star seed rides the Maple row with its trait tag.
  const maple = cjkPopup.locator(".kit-fp", { hasText: "29.2k" });
  await expect(maple).toContainText("Maple Mono");
  await expect(maple).toContainText("圆角等宽");
  await page.keyboard.press("Escape");

  assertNoJsErrors(errors);
});

test("a catalog family verifies, becomes pickable, and self-renders", async ({
  page,
}) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);
  await loadCatalogPage(page);

  // The first family in release order verifies quickly; picking it
  // loads the REAL font (its face registers through the serve's byte
  // hrefs) and the card renders the family name in its own typeface.
  await pickCatalogFamily(page, "en", "0xProto", 240_000, "0xProto Nerd Font");
  const name = page.locator('[data-role="picker-en"] .kit-hd b');
  // Round 9: the card reads the face's own name-table string.
  await expect(name).toHaveText("0xProto Nerd Font");
  await expect
    .poll(() => name.evaluate((el) => getComputedStyle(el).fontFamily))
    .not.toBe("");

  assertNoJsErrors(errors);
});

test("the real catalog drives the live submission end to end", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  collectJsErrors(page, errors);
  await loadCatalogPage(page);

  // Both picks from real families — JetBrainsMono as the base, the
  // Maple build as the donor (the prototype's own pair; a plain family
  // pick serves the DEFAULT cut's faces — Maple's NF entry, 「Maple
  // Mono NF」).
  await pickCatalogFamily(page, "en", "JetBrainsMono Nerd Font");
  await pickCatalogFamily(page, "cjk", "Maple Mono", 240_000, "Maple Mono NF");

  // The pair tags carry both picks as plain text — the name-table
  // display names (the same ones the picker rows and rail cards
  // render; the raw manifest ids never reach the UI).
  await expect(page.locator(".topbar [data-pair='base']")).toHaveText(
    "JetBrainsMono Nerd Font",
  );
  await expect(page.locator(".topbar [data-pair='donor']")).toHaveText(
    "Maple Mono NF",
  );

  // Open-at-the-selection: the EN picker reopens with the checked row
  // already scrolled into the popup's viewport — the scroll area
  // scrolls, not the page.
  const reopened = await openFontPicker(page, "en");
  const inView = await reopened.evaluate((popup) => {
    const area = popup.querySelector(".kit-pks");
    const row = popup.querySelector(".kit-fp[aria-pressed='true']");
    if (!(area instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      return { ok: false, scrollTop: -1 };
    }
    const a = area.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return {
      ok: r.top >= a.top - 1 && r.bottom <= a.bottom + 1,
      scrollTop: area.scrollTop,
    };
  });
  expect(inView.ok).toBe(true);
  expect(inView.scrollTop).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");

  // Rules land in the recipe through the workspace's affordances: a
  // fresh state already declares zh_cn under 文字范围 (the pressed chip);
  // the 日文 chip adds ja (round 5: the four chips are the rail's whole
  // preset surface), the 按编码指定 popup adds a custom range and a
  // single codepoint (留空=单个).
  await pointerClick(
    page,
    page.locator("[data-role='lang-chip'][data-preset='ja']"),
  );

  await pointerClick(page, page.locator("[data-role='range-specify']"));
  const rangePopup = page.locator("[data-range-popup]");
  await expect(rangePopup).toBeVisible();
  await rangePopup.locator("[data-role='range-start']").fill("0x2100");
  await rangePopup.locator("[data-role='range-end']").fill("0x214F");
  await pointerClick(page, rangePopup.locator("[data-role='range-add']"));

  await pointerClick(page, page.locator("[data-role='range-specify']"));
  await expect(rangePopup).toBeVisible();
  await rangePopup.locator("[data-role='range-start']").fill("0x4E2D");
  await rangePopup.locator("[data-role='range-end']").fill("");
  await pointerClick(page, rangePopup.locator("[data-role='range-add']"));

  // Settings land in the recipe's normalization block (the 1.5x width
  // factor is the prototype's compacter CJK width setting).
  await pickSelectOption(
    page,
    page.locator('[data-role="select-baseline"]'),
    "optical",
  );
  await pickSelectOption(
    page,
    page.locator('[data-role="select-cjkWidth"]'),
    "1.5",
  );

  // The synthesize action runs the LIVE flow against the suite's
  // serve. Its submitted body is the workspace's own recipe (ticket
  // #29: one recipe model, one wire-JSON serializer) — the same JSON
  // the old no-service panel previewed, pinned here at the POST seam
  // the serve validates: catalog-family references for the two real
  // picks (round 6: the base carries the family-cut pattern), the
  // three rail rules, the normalization switches.
  const bodyPromise = new Promise<Record<string, unknown>>((resolveBody) => {
    page.on("request", (request: Request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/builds")
      ) {
        resolveBody(request.postDataJSON() as Record<string, unknown>);
      }
    });
  });
  await pointerClick(page, page.locator(".topbar [data-role='synthesize']"));
  const panel = page.locator('[data-testid="build-panel"]');
  await expect(panel).toBeVisible();

  const body = (await bodyPromise) as {
    base: Record<string, unknown>;
    donors: Array<Record<string, unknown>>;
    rules: unknown;
    normalization: unknown;
    output: unknown;
  };
  expect(body.base).toEqual({
    family: "JetBrainsMono",
    variant: "Nerd Font",
    pattern: "JetBrainsMonoNerdFont-*.ttf",
  });
  expect(body.donors).toEqual([
    { family: "MapleMono", variant: "NF" },
  ]);
  // The boot-seeded zh_cn preset (the declared 文字范围 scope) first,
  // then the 日文 chip's ja preset, then the 按编码指定 rules (the range
  // and the single codepoint). Round 6: side assignments carry the
  // [side, other] preference lists — "用X字体" means X first, the other
  // font filling what X lacks.
  expect(body.rules).toEqual([
    { set: "zh_cn", fonts: ["base", "donor-0"] },
    { set: "ja", fonts: ["base", "donor-0"] },
    { range: "0x2100-0x214F", fonts: ["base", "donor-0"] },
    // 留空=单个: a one-codepoint range (the popup's single form).
    { range: "0x4E2D-0x4E2D", fonts: ["base", "donor-0"] },
  ]);
  expect(body.normalization).toEqual({
    mode: "optical",
    width_factor: 1.5,
  });
  // A catalog-family base pick packages the family's whole weight
  // matrix (the pattern above), so the resolved output format is ttc —
  // the draft's own extension rule, not a topbar setting.
  expect(body.output).toEqual({ format: "ttc", family: "ChHsich" });

  // The submission reached a running build (the minutes-long merge is
  // the journey suites' story — J11 walks it to the report; this spec
  // pins the recipe contract and leaves the build to the shared
  // serve's teardown).
  const stage = panel.locator("[data-build-stage]").first();
  await expect(stage).toContainText(/排队|正在合成|读取字体/, {
    timeout: 30_000,
  });

  assertNoJsErrors(errors);
});

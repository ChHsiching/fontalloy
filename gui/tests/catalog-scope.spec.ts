import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateNamedFace, spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type SiteFamilySpec,
} from "./catalog-serve-site";

test.describe("first-run catalog scope choice (ADR-0010)", () => {
  const jsErrors: string[] = [];
  let serveUrl = "";
  let disposeServe: (() => Promise<void>) | null = null;
  let cleanupRoots: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-scope-"));
    const faceA = await generateNamedFace(root, "Scope A", "ScopeFontA");
    const faceB = await generateNamedFace(root, "Scope B", "ScopeFontB");
    const specs: SiteFamilySpec[] = [
      {
        family: "ScopeFontA",
        faces: [{ file: "ScopeFontA-Regular.ttf", fontPath: faceA }],
      },
      {
        family: "ScopeFontB",
        faces: [{ file: "ScopeFontB-Regular.ttf", fontPath: faceB }],
      },
    ];
    const site = await buildServeCatalogSite(specs);
    const spawned = await spawnServeOverFonts(site.catalogDir, [
      "--catalog-release-origin",
      site.originUri,
      "--catalog-dir",
      site.catalogDir,
      "--catalog-scope",
      "choose",
    ]);
    serveUrl = await spawned.url;
    disposeServe = () => spawned.dispose();
    cleanupRoots = async () => {
      await rm(root, { recursive: true, force: true });
      await rm(site.root, { recursive: true, force: true });
    };
  });

  test.afterAll(async () => {
    await disposeServe?.();
    await cleanupRoots?.();
  });

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.addInitScript((serve: string) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  async function statusFamilies(): Promise<Map<string, string>> {
    const response = await fetch(`${serveUrl}/catalog/status`);
    const doc = (await response.json()) as {
      families: Array<{ family: string; state: string }>;
    };
    return new Map(doc.families.map((f) => [f.family, f.state]));
  }

  test("an undecided scope owns the first-run panel with two entries", async ({
    page,
  }) => {
    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    // The choice replaces the progress story: cards visible, the bar
    // and the counter are not.
    const choice = page.locator("[data-role='catalog-choice']");
    await expect(choice).toBeVisible();
    await expect(page.locator("[data-role='catalog-bar']")).toBeHidden();
    await expect(page.locator(".catalog-progress")).toBeHidden();
    // Native buttons with real accessible names (keyboard + AT for free).
    await expect(
      choice.getByRole("button", { name: /下载全部字体/ }),
    ).toBeVisible();
    await expect(
      choice.getByRole("button", { name: /按需使用/ }),
    ).toBeVisible();
  });

  test("on-demand enters immediately; a row click delivers exactly that family", async ({
    page,
  }) => {
    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    await pointerClick(
      page,
      page
        .locator("[data-role='catalog-choice']")
        .getByRole("button", { name: /按需使用/ }),
    );
    // The serve settles ready on its own and the screen closes NOW —
    // the user chose to start using the app.
    await expect(screen).toBeHidden({ timeout: 15_000 });

    // The listing is live with every family — tagged 未下载, not a
    // syncing lie.
    const card = page.locator(".kit-fsel[data-role='picker-en']");
    await pointerClick(page, card.locator(".kit-hd"));
    const popup = page.locator("[data-picker-popup='en']");
    await expect(popup).toBeVisible();
    const rowA = popup.locator(".kit-fp", { hasText: "ScopeFontA" });
    await expect(rowA).toBeVisible();
    await expect(rowA).toContainText("未下载");

    // The click fetches exactly ScopeFontA: the serve delivers it (and
    // ONLY it) — the POST, delivery, and document computation are the
    // layers this test can see reliably end to end.
    await pointerClick(page, rowA);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const states = await statusFamilies();
      if (states.get("ScopeFontA") === "done") break;
      if (Date.now() > deadline) {
        throw new Error(`ScopeFontA never delivered: ${[...states]}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const states = await statusFamilies();
    expect(states.get("ScopeFontB")).toBe("pending");
  });

  // Root cause found and fixed (owner item 3): the kit closed the
  // popup unconditionally on row click, so the on-demand download's
  // progress rendered into a zombie popup (open:false — the DBG-POPS
  // probe caught it). onPick now returns "keep-open" for the
  // fetch-then-select path and closes when the pick lands.
  test("the fetched row clears its tag and lands the pick", async ({
    page,
  }) => {
    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    await pointerClick(
      page,
      page
        .locator("[data-role='catalog-choice']")
        .getByRole("button", { name: /按需使用/ }),
    );
    await expect(screen).toBeHidden({ timeout: 15_000 });
    const card = page.locator(".kit-fsel[data-role='picker-en']");
    await pointerClick(page, card.locator(".kit-hd"));
    const popup = page.locator("[data-picker-popup='en']");
    await expect(popup).toBeVisible();
    const rowA = popup.locator(".kit-fp", { hasText: "ScopeFontA" });
    await expect(rowA).toContainText("未下载");
    await pointerClick(page, rowA);
    // The popup STAYS OPEN while the family downloads; the row's tag
    // clears and the pick lands (closing it) when the document is ready.
    await expect(rowA).not.toContainText("未下载", { timeout: 30_000 });
    await expect(card.locator(".kit-hd")).toContainText("ScopeFontA", {
      timeout: 30_000,
    });
  });

  test("the choice is remembered — a reload never asks again", async ({
    page,
  }) => {
    // fullyParallel gives every test its own fresh serve; record the
    // choice node-side, then prove a full page load never re-asks.
    await fetch(`${serveUrl}/catalog/scope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "on-demand" }),
    });
    await page.reload();
    await waitForFontsReady(page);
    await page.waitForTimeout(1_000);
    await expect(page.locator(".catalog-screen")).toBeHidden();
  });
});

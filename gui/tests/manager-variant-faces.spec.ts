import { expect, test } from "@playwright/test";
import { variantFaceFiles, pickVariantRepresentative } from "../src/catalog/faceSet";

/**
 * Round-17 item 1: a multi-cut family's zip carries every cut's faces
 * (MapleMono ships NF and NF-CN under one family). The variant filter
 * must keep a cut's face set to ITS OWN cut.
 *
 * Round 20 (owner item 2): the discriminators are IFF rules written
 * against the REAL face names the pinned artifacts carry (listed from
 * the actual zips — BizinGothic NF ships BizinGothicNF plus
 * BizinGothicDiscordNF; HackGen NF ships Console faces only; UDEVGothic
 * NF ships 35/NF/LG mixes; NotoSansSC's three entries are Adobe's
 * SourceHanSansHWSC, Google's NotoSansMonoCJKsc, and the variable
 * NotoSansSC[wght]). Every axis the manifest records on a cut — nf,
 * cn, hw, mono, gb, tc, screen, plus, variable — rides the variant
 * word IFF it rides the file name, AFTER stripping the family's own
 * name prefix (MapleMono's "Mono" is the family word, not a width
 * axis; Go-Mono's GoMonoNerdFont face must not read as a Mono cut).
 * Weight words stay one-directional: WenKai's Light/Medium/Regular
 * entries are one cut whose matrix pools every weight.
 */
const MAPLE_FILES = [
  { file: "MapleMono-NF-Bold.ttf" },
  { file: "MapleMono-NF-CN-Bold.ttf" },
  { file: "MapleMono-NF-CN-Regular.ttf" },
  { file: "MapleMono-NF-Regular.ttf" },
  { file: "MapleMonoCN-Regular.ttf" },
];

/** The real union the NotoSansSC entries produce (Adobe + Google + VF). */
const NOTO_SANS_SC_FILES = [
  { file: "NotoSansMonoCJKsc-Bold.otf" },
  { file: "NotoSansMonoCJKsc-Regular.otf" },
  { file: "NotoSansSC[wght].ttf" },
  { file: "SourceHanSansHWSC-Bold.otf" },
  { file: "SourceHanSansHWSC-Regular.otf" },
];

/** The real BizinGothic union: the NF zip carries a Discord sub-face. */
const BIZIN_FILES = [
  { file: "BizinGothic-Bold.ttf" },
  { file: "BizinGothic-Regular.ttf" },
  { file: "BizinGothicDiscordNF-Bold.ttf" },
  { file: "BizinGothicDiscordNF-Regular.ttf" },
  { file: "BizinGothicNF-Bold.ttf" },
  { file: "BizinGothicNF-Regular.ttf" },
];

/** The real HackGen union: NF ships Console faces only. */
const HACKGEN_FILES = [
  { file: "HackGen-Bold.ttf" },
  { file: "HackGen-Regular.ttf" },
  { file: "HackGen35-Bold.ttf" },
  { file: "HackGen35-Regular.ttf" },
  { file: "HackGen35Console-Bold.ttf" },
  { file: "HackGen35Console-Regular.ttf" },
  { file: "HackGenConsole-Bold.ttf" },
  { file: "HackGenConsole-Regular.ttf" },
  { file: "HackGen35ConsoleNF-Bold.ttf" },
  { file: "HackGen35ConsoleNF-Regular.ttf" },
  { file: "HackGenConsoleNF-Bold.ttf" },
  { file: "HackGenConsoleNF-Regular.ttf" },
];

/** The real UDEVGothic union: 24 standard + 16 NF faces. */
const UDEV_FAMILIES = ["UDEVGothic", "UDEVGothic35", "UDEVGothic35JPDOC", "UDEVGothic35LG", "UDEVGothicJPDOC", "UDEVGothicLG"];
const UDEV_NF_FAMILIES = ["UDEVGothic35NF", "UDEVGothic35NFLG", "UDEVGothicNF", "UDEVGothicNFLG"];
const UDEV_STYLES = ["Bold", "BoldItalic", "Italic", "Regular"];
const UDEV_FILES = [
  ...UDEV_FAMILIES.flatMap((f) => UDEV_STYLES.map((s) => ({ file: `${f}-${s}.ttf` }))),
  ...UDEV_NF_FAMILIES.flatMap((f) => UDEV_STYLES.map((s) => ({ file: `${f}-${s}.ttf` }))),
];

/** The real LxgwBrightCode union: six cuts, two weights shown each. */
const BRIGHT_CUTS = ["", "GB", "TC", "NF", "NFGB", "NFTC"];
const LXGW_BRIGHT_FILES = BRIGHT_CUTS.flatMap((cut) =>
  ["Light", "Regular"].map((w) => ({ file: `LXGWBrightCode${cut}-${w}.ttf` })),
);

const filesOf = (files: ReadonlyArray<{ file: string }>, variant: string, family: string) =>
  variantFaceFiles(files, variant, family).map((f) => f.file).sort();

test.describe("variantFaceFiles cut discrimination", () => {
  test("the NF cut keeps only NF faces", () => {
    expect(filesOf(MAPLE_FILES, "NF", "MapleMono")).toEqual([
      "MapleMono-NF-Bold.ttf",
      "MapleMono-NF-Regular.ttf",
    ]);
  });

  test("the NF-CN cut keeps only NF-CN faces", () => {
    expect(filesOf(MAPLE_FILES, "NF-CN", "MapleMono")).toEqual([
      "MapleMono-NF-CN-Bold.ttf",
      "MapleMono-NF-CN-Regular.ttf",
    ]);
  });

  test("the family's own name words are not cut axes (MapleMono is not a Mono cut)", () => {
    // Round 20: MapleMono's every file carries "mono" as the FAMILY
    // word; the mono IFF rule must not blank the NF cut (and the
    // round-17 prototype-era bare CN face matches neither cut).
    expect(filesOf(MAPLE_FILES, "NF", "MapleMono")).toHaveLength(2);
    expect(filesOf(MAPLE_FILES, "NF-CN", "MapleMono")).toHaveLength(2);
  });

  test("NotoSansSC: HW, Mono and Variable each select exactly their entry's faces", () => {
    expect(filesOf(NOTO_SANS_SC_FILES, "HW", "NotoSansSC")).toEqual([
      "SourceHanSansHWSC-Bold.otf",
      "SourceHanSansHWSC-Regular.otf",
    ]);
    expect(filesOf(NOTO_SANS_SC_FILES, "Mono", "NotoSansSC")).toEqual([
      "NotoSansMonoCJKsc-Bold.otf",
      "NotoSansMonoCJKsc-Regular.otf",
    ]);
    expect(filesOf(NOTO_SANS_SC_FILES, "Variable", "NotoSansSC")).toEqual([
      "NotoSansSC[wght].ttf",
    ]);
  });

  test("BizinGothic: NF keeps the NF zip's faces (Discord included), Standard the plain ones", () => {
    expect(filesOf(BIZIN_FILES, "NF", "BizinGothic")).toEqual([
      "BizinGothicDiscordNF-Bold.ttf",
      "BizinGothicDiscordNF-Regular.ttf",
      "BizinGothicNF-Bold.ttf",
      "BizinGothicNF-Regular.ttf",
    ]);
    expect(filesOf(BIZIN_FILES, "Standard", "BizinGothic")).toEqual([
      "BizinGothic-Bold.ttf",
      "BizinGothic-Regular.ttf",
    ]);
  });

  test("HackGen: NF is the ConsoleNF artifact, Standard the plain one's sub-faces", () => {
    expect(filesOf(HACKGEN_FILES, "NF", "HackGen")).toEqual([
      "HackGen35ConsoleNF-Bold.ttf",
      "HackGen35ConsoleNF-Regular.ttf",
      "HackGenConsoleNF-Bold.ttf",
      "HackGenConsoleNF-Regular.ttf",
    ]);
    expect(filesOf(HACKGEN_FILES, "Standard", "HackGen")).toEqual([
      "HackGen-Bold.ttf",
      "HackGen-Regular.ttf",
      "HackGen35-Bold.ttf",
      "HackGen35-Regular.ttf",
      "HackGen35Console-Bold.ttf",
      "HackGen35Console-Regular.ttf",
      "HackGenConsole-Bold.ttf",
      "HackGenConsole-Regular.ttf",
    ]);
  });

  test("UDEVGothic: NF keeps the 16 NF faces, Standard the 24 plain ones", () => {
    expect(filesOf(UDEV_FILES, "NF", "UDEVGothic")).toEqual(
      UDEV_NF_FAMILIES.flatMap((f) => UDEV_STYLES.map((s) => `${f}-${s}.ttf`)).sort(),
    );
    expect(filesOf(UDEV_FILES, "Standard", "UDEVGothic")).toEqual(
      UDEV_FAMILIES.flatMap((f) => UDEV_STYLES.map((s) => `${f}-${s}.ttf`)).sort(),
    );
  });

  test("LxgwBrightCode: all six cuts disambiguate (nf x gb x tc, IFF both ways)", () => {
    const byCut = (cut: string) => [`LXGWBrightCode${cut}-Light.ttf`, `LXGWBrightCode${cut}-Regular.ttf`];
    expect(filesOf(LXGW_BRIGHT_FILES, "Standard", "LxgwBrightCode")).toEqual(byCut(""));
    expect(filesOf(LXGW_BRIGHT_FILES, "GB", "LxgwBrightCode")).toEqual(byCut("GB"));
    expect(filesOf(LXGW_BRIGHT_FILES, "TC", "LxgwBrightCode")).toEqual(byCut("TC"));
    expect(filesOf(LXGW_BRIGHT_FILES, "NF", "LxgwBrightCode")).toEqual(byCut("NF"));
    expect(filesOf(LXGW_BRIGHT_FILES, "NF-GB", "LxgwBrightCode")).toEqual(byCut("NFGB"));
    expect(filesOf(LXGW_BRIGHT_FILES, "NF-TC", "LxgwBrightCode")).toEqual(byCut("NFTC"));
  });

  test("Plus is a cut axis: the Regular cut does not pool the Plus face", () => {
    const files = [{ file: "LXGWNeoXiHei.ttf" }, { file: "LXGWNeoXiHeiPlus.ttf" }];
    expect(filesOf(files, "Regular", "LxgwNeoXiHei")).toEqual(["LXGWNeoXiHei.ttf"]);
    expect(filesOf(files, "Plus", "LxgwNeoXiHei")).toEqual(["LXGWNeoXiHeiPlus.ttf"]);
  });

  test("weight is not a cut: the WenKai cut pools every weight", () => {
    const files = [
      { file: "LXGWWenKai-Light.ttf" },
      { file: "LXGWWenKai-Medium.ttf" },
      { file: "LXGWWenKai-Regular.ttf" },
    ];
    expect(filesOf(files, "Regular", "LXGWWenKai")).toEqual([
      "LXGWWenKai-Light.ttf",
      "LXGWWenKai-Medium.ttf",
      "LXGWWenKai-Regular.ttf",
    ]);
  });

  test("the family prefix strip is dash-tolerant (Go-Mono's faces are not Mono cuts)", () => {
    const files = [
      { file: "GoMonoNerdFont-Bold.ttf" },
      { file: "GoMonoNerdFont-Regular.ttf" },
    ];
    expect(filesOf(files, "Nerd Font", "Go-Mono")).toEqual([
      "GoMonoNerdFont-Bold.ttf",
      "GoMonoNerdFont-Regular.ttf",
    ]);
  });

  test("a region word is not a cn cut (GlowSans SC-Normal keeps its faces)", () => {
    const files = [
      { file: "GlowSansSC-Normal-Bold.otf" },
      { file: "GlowSansSC-Normal-Regular.otf" },
    ];
    expect(filesOf(files, "SC-Normal", "GlowSans")).toEqual([
      "GlowSansSC-Normal-Bold.otf",
      "GlowSansSC-Normal-Regular.otf",
    ]);
  });

  test("a Nerd Font family's zip drops the Mono sub-cut faces from the plain pick", () => {
    // "propo" is not a manifest axis, so Propo faces stay in the set —
    // the representative pick and the name-table sibling filter keep
    // them from ever surfacing as the pick. "mono" IS an axis
    // (NotoSansSC), so the Mono sub-cut is excluded here.
    const files = [
      { file: "JetBrainsMonoNLNerdFont-Regular.ttf" },
      { file: "JetBrainsMonoNLNerdFontMono-Regular.ttf" },
      { file: "JetBrainsMonoNLNerdFontPropo-Regular.ttf" },
      { file: "JetBrainsMonoNerdFont-Regular.ttf" },
      { file: "JetBrainsMonoNerdFontMono-Regular.ttf" },
      { file: "JetBrainsMonoNerdFontPropo-Regular.ttf" },
    ];
    expect(filesOf(files, "Nerd Font", "JetBrainsMono")).toEqual([
      "JetBrainsMonoNLNerdFont-Regular.ttf",
      "JetBrainsMonoNLNerdFontPropo-Regular.ttf",
      "JetBrainsMonoNerdFont-Regular.ttf",
      "JetBrainsMonoNerdFontPropo-Regular.ttf",
    ]);
  });

  test("a single-file family resolves to itself regardless of variant", () => {
    expect(variantFaceFiles([{ file: "LXGWWenKai-Regular.ttf" }], null)).toEqual(
      [{ file: "LXGWWenKai-Regular.ttf" }],
    );
  });
});

test.describe("pickVariantRepresentative", () => {
  test("the plainest Regular of the cut is the representative, not the alphabetically-first sub-face", () => {
    expect(pickVariantRepresentative(UDEV_FILES, "NF", "UDEVGothic")?.file).toBe(
      "UDEVGothicNF-Regular.ttf",
    );
    expect(pickVariantRepresentative(HACKGEN_FILES, "NF", "HackGen")?.file).toBe(
      "HackGenConsoleNF-Regular.ttf",
    );
    expect(
      pickVariantRepresentative(
        [
          { file: "JetBrainsMonoNLNerdFont-Regular.ttf" },
          { file: "JetBrainsMonoNerdFont-Regular.ttf" },
        ],
        "Nerd Font",
        "JetBrainsMono",
      )?.file,
    ).toBe("JetBrainsMonoNerdFont-Regular.ttf");
  });

  test("a cut with one Regular and a variable cut both resolve", () => {
    expect(pickVariantRepresentative(MAPLE_FILES, "NF-CN", "MapleMono")?.file).toBe(
      "MapleMono-NF-CN-Regular.ttf",
    );
    expect(pickVariantRepresentative(NOTO_SANS_SC_FILES, "Variable", "NotoSansSC")?.file).toBe(
      "NotoSansSC[wght].ttf",
    );
    expect(pickVariantRepresentative(NOTO_SANS_SC_FILES, "HW", "NotoSansSC")?.file).toBe(
      "SourceHanSansHWSC-Regular.otf",
    );
  });

  test("a face set with no Regular-named face falls back to the set itself", () => {
    expect(
      pickVariantRepresentative([{ file: "LXGWNeoXiHei.ttf" }], "Regular", "LxgwNeoXiHei")?.file,
    ).toBe("LXGWNeoXiHei.ttf");
  });
});

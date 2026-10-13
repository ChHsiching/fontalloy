import { expect, test } from "@playwright/test";
import { variantFaceFiles } from "../src/catalog/faceSet";

/**
 * Round-17 item 1: a multi-cut family's zip carries every cut's faces
 * (MapleMono ships NF and NF-CN under one family). The variant filter
 * must keep a cut's face set to ITS OWN cut: the cn token discriminates
 * (present in the variant IFF present in the file), and the
 * prototype-era non-NF CN face matches NEITHER cut.
 */
const MAPLE_FILES = [
  { file: "MapleMono-NF-Bold.ttf" },
  { file: "MapleMono-NF-CN-Bold.ttf" },
  { file: "MapleMono-NF-CN-Regular.ttf" },
  { file: "MapleMono-NF-Regular.ttf" },
  { file: "MapleMonoCN-Regular.ttf" },
];

test.describe("variantFaceFiles cut discrimination", () => {
  test("the NF cut keeps only NF faces", () => {
    expect(
      variantFaceFiles(MAPLE_FILES, "NF").map((f) => f.file).sort(),
    ).toEqual(["MapleMono-NF-Bold.ttf", "MapleMono-NF-Regular.ttf"]);
  });

  test("the NF-CN cut keeps only NF-CN faces", () => {
    expect(
      variantFaceFiles(MAPLE_FILES, "NF-CN").map((f) => f.file).sort(),
    ).toEqual(["MapleMono-NF-CN-Bold.ttf", "MapleMono-NF-CN-Regular.ttf"]);
  });

  test("a single-file family resolves to itself regardless of variant", () => {
    expect(variantFaceFiles([{ file: "LXGWWenKai-Regular.ttf" }], null)).toEqual(
      [{ file: "LXGWWenKai-Regular.ttf" }],
    );
  });
});

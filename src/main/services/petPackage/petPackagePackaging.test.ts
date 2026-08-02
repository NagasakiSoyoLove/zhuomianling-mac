import { describe, expect, it } from "vitest";
import { isProductionNodeModulePath } from "../../../../scripts/release-asset-policy.mjs";

describe("pet package runtime dependency release boundary", () => {
  it("allows only the reviewed streaming ZIP runtime files", () => {
    for (const approved of [
      "node_modules/yazl/index.js",
      "node_modules/yauzl/index.js",
      "node_modules/yauzl/fd-slicer.js",
      "node_modules/pend/index.js",
      "node_modules/buffer-crc32/dist/index.cjs"
    ]) expect(isProductionNodeModulePath(approved)).toBe(false);

    for (const forbidden of [
      "node_modules/pend/test.js",
      "node_modules/yauzl/example.js",
      "node_modules/unknown/index.js",
      "node_modules/buffer-crc32/dist/index.d.cts"
    ]) expect(isProductionNodeModulePath(forbidden)).toBe(true);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { PET_PACKAGE_KIND, type PetPackageManifestV1, type PortablePetDefinitionV1 } from "../../../shared/types/petPackage";
import { hashFile, writePetPackageArchive } from "./petPackageArchive";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

function zipNames(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error); return; }
    const names: string[] = [];
    zip.on("entry", (entry) => { names.push(entry.fileName); zip.readEntry(); });
    zip.on("end", () => resolve(names));
    zip.on("error", reject);
    zip.readEntry();
  }));
}

describe("streaming pet package archive", () => {
  it("hashes and writes manifest, portable config, and resources without a whole-file buffer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zmling-archive-")); roots.push(root);
    const source = path.join(root, "texture.png");
    await fs.writeFile(source, Buffer.alloc(2 * 1024 * 1024, 7));
    let hashedBytes = 0;
    const file = { sourcePath: source, archivePath: "live2d/texture.png", size: 2 * 1024 * 1024 };
    const sha256 = await hashFile(file, new AbortController().signal, (count) => { hashedBytes += count; });
    expect(hashedBytes).toBe(file.size);
    const portable = { schemaVersion: 1, live2dEntry: "live2d/model.json", name: "A" } as PortablePetDefinitionV1;
    const manifest: PetPackageManifestV1 = {
      kind: PET_PACKAGE_KIND, formatVersion: 1, exportedAt: new Date().toISOString(), appVersion: "test",
      pet: { originalPetId: "a", name: "A" }, requirements: { ai: false, gptSoVits: false },
      entries: [{ path: file.archivePath, size: file.size, sha256 }]
    };
    const destination = path.join(root, "pet.zmling");
    let written = 0;
    await writePetPackageArchive({ destinationPath: destination, manifest, portablePet: portable, files: [file], signal: new AbortController().signal, onCompressedBytes: (count) => { written += count; } });
    expect(written).toBeGreaterThan(0);
    await expect(zipNames(destination)).resolves.toEqual(["manifest.json", "pet.json", "live2d/texture.png"]);
  });

  it("does not expose a destination or temporary package after cancellation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zmling-cancel-")); roots.push(root);
    const source = path.join(root, "large.bin");
    await fs.writeFile(source, Buffer.alloc(1024 * 1024, 1));
    const controller = new AbortController(); controller.abort();
    const destination = path.join(root, "canceled.zmling");
    await expect(writePetPackageArchive({
      destinationPath: destination,
      manifest: { kind: PET_PACKAGE_KIND, formatVersion: 1, exportedAt: "now", appVersion: "test", pet: { originalPetId: "a", name: "A" }, requirements: { ai: false, gptSoVits: false }, entries: [] },
      portablePet: { schemaVersion: 1, live2dEntry: "live2d/model.json", name: "A" } as PortablePetDefinitionV1,
      files: [{ sourcePath: source, archivePath: "live2d/large.bin", size: 1024 * 1024 }], signal: controller.signal, onCompressedBytes: () => undefined
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.access(destination)).rejects.toThrow();
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

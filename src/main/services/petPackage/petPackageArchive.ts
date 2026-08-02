import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ZipFile } from "yazl";
import type { PetPackageManifestV1, PortablePetDefinitionV1 } from "../../../shared/types/petPackage";
import type { PackageSourceFile } from "./petPackagePaths";

function abortError(): Error { return Object.assign(new Error("操作已取消。"), { name: "AbortError" }); }

export async function hashFile(file: PackageSourceFile, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<string> {
  const hash = createHash("sha256");
  const stream = fsSync.createReadStream(file.sourcePath);
  const abort = (): void => { stream.destroy(abortError()); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = chunk as Buffer;
      hash.update(bytes);
      onBytes(bytes.length);
    }
    return hash.digest("hex");
  } finally { signal.removeEventListener("abort", abort); }
}

export async function writePetPackageArchive(options: {
  destinationPath: string;
  manifest: PetPackageManifestV1;
  portablePet: PortablePetDefinitionV1;
  files: PackageSourceFile[];
  signal: AbortSignal;
  onCompressedBytes: (bytes: number) => void;
}): Promise<number> {
  options.signal.throwIfAborted();
  const temporaryPath = path.join(path.dirname(options.destinationPath), `.${path.basename(options.destinationPath)}.${process.pid}.${Date.now()}.tmp`);
  const zip = new ZipFile();
  let output: fsSync.WriteStream | undefined;
  const abort = (): void => {
    zip.end();
    output?.destroy(abortError());
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    output = fsSync.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
    let lastBytes = 0;
    zip.outputStream.on("data", () => {
      const current = output?.bytesWritten ?? lastBytes;
      options.onCompressedBytes(Math.max(0, current - lastBytes));
      lastBytes = current;
    });
    const completion = new Promise<void>((resolve, reject) => {
      output!.once("close", resolve);
      output!.once("error", reject);
      zip.outputStream.once("error", reject);
    });
    zip.outputStream.pipe(output);
    zip.addBuffer(Buffer.from(`${JSON.stringify(options.manifest, null, 2)}\n`), "manifest.json");
    zip.addBuffer(Buffer.from(`${JSON.stringify(options.portablePet, null, 2)}\n`), "pet.json");
    for (const file of options.files) {
      options.signal.throwIfAborted();
      zip.addFile(file.sourcePath, file.archivePath);
    }
    zip.end();
    await completion;
    options.signal.throwIfAborted();
    const handle = await fs.open(temporaryPath, "r+");
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, options.destinationPath);
    const directory = await fs.open(path.dirname(options.destinationPath), "r").catch(() => undefined);
    await directory?.sync().catch(() => undefined);
    await directory?.close().catch(() => undefined);
    return (await fs.stat(options.destinationPath)).size;
  } finally {
    options.signal.removeEventListener("abort", abort);
    if (output && !output.closed) {
      output.destroy();
      await new Promise<void>((resolve) => {
        output!.once("close", resolve);
        output!.once("error", () => resolve());
      });
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

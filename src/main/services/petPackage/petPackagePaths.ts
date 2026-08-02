import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { assertPathContained } from "../config/petConfigPersistence";

export interface PackageSourceFile { sourcePath: string; archivePath: string; size: number; sha256?: string }

export async function assertRegularContainedFile(rootPath: string, filePath: string): Promise<Stats> {
  const lexicalRoot = path.resolve(rootPath);
  const lexicalFile = path.resolve(filePath);
  assertPathContained(lexicalRoot, lexicalFile, "桌宠资源路径越界。");
  const stat = await fs.lstat(lexicalFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("桌宠资源包含不支持的链接或特殊文件。");
  const [realRoot, realFile] = await Promise.all([fs.realpath(lexicalRoot), fs.realpath(lexicalFile)]);
  assertPathContained(realRoot, realFile, "桌宠资源 realpath 越界。");
  return stat;
}

export async function enumerateRegularFiles(rootPath: string, archiveRoot: string, signal: AbortSignal): Promise<PackageSourceFile[]> {
  const result: PackageSourceFile[] = [];
  const walk = async (directoryPath: string): Promise<void> => {
    signal.throwIfAborted();
    const directoryStat = await fs.lstat(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("桌宠资源目录包含符号链接或联接。");
    const realRoot = await fs.realpath(rootPath);
    const realDirectory = await fs.realpath(directoryPath);
    if (path.resolve(realRoot) !== path.resolve(realDirectory)) assertPathContained(realRoot, realDirectory, "桌宠资源目录越界。");
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted();
      const childPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error("桌宠资源包含符号链接或联接。");
      if (entry.isDirectory()) await walk(childPath);
      else if (entry.isFile()) {
        const stat = await assertRegularContainedFile(rootPath, childPath);
        const relative = path.relative(rootPath, childPath).split(path.sep).join("/");
        result.push({ sourcePath: childPath, archivePath: `${archiveRoot}/${relative}`, size: stat.size });
      } else throw new Error("桌宠资源包含特殊文件。");
    }
  };
  await walk(rootPath);
  return result;
}

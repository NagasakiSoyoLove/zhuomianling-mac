import fs from "node:fs/promises";
import path from "node:path";
import type { PackageSourceFile } from "./petPackagePaths";

const live2dFilePattern = /(?:\.moc3?|\.mtn|\.json|\.(?:png|jpe?g|webp)|\.(?:wav|mp3|ogg))$/i;
const maximumJsonBytes = 16 * 1024 * 1024;
const maximumJsonNodes = 100_000;

export function isAllowedLive2DPackagePath(archivePath: string): boolean {
  return archivePath.startsWith("live2d/") && live2dFilePattern.test(archivePath);
}

function collectFileLikeStrings(value: unknown): string[] {
  const result: string[] = [];
  let nodes = 0;
  const visit = (current: unknown): void => {
    nodes += 1;
    if (nodes > maximumJsonNodes) throw new Error("Live2D JSON 结构超出安全限制。");
    if (typeof current === "string") {
      if (live2dFilePattern.test(current)) result.push(current);
      return;
    }
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (current && typeof current === "object") Object.values(current as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return result;
}

export async function selectLive2DDependencyFiles(options: {
  rootPath: string;
  entryRelativePath: string;
  allFiles: PackageSourceFile[];
  fallbackRelativePaths?: string[];
}): Promise<PackageSourceFile[]> {
  const byRelativePath = new Map(options.allFiles.map((file) => [
    path.relative(options.rootPath, file.sourcePath).split(path.sep).join("/").toLocaleLowerCase("en-US"),
    file
  ]));
  const selected = new Map<string, PackageSourceFile>();
  const jsonQueue: PackageSourceFile[] = [];
  const addRelative = (rawRelative: string, baseDirectory = options.rootPath): void => {
    if (/^(?:[A-Za-z]:|[/\\]{1,2}|[a-z][a-z0-9+.-]*:)/i.test(rawRelative) || rawRelative.includes("\0")) throw new Error("Live2D JSON 引用了外部或绝对资源。");
    const absolute = path.resolve(baseDirectory, rawRelative.replace(/[\\/]/g, path.sep));
    const relative = path.relative(options.rootPath, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Live2D JSON 依赖越界。");
    const key = relative.split(path.sep).join("/").toLocaleLowerCase("en-US");
    const file = byRelativePath.get(key);
    if (!file) throw new Error(`Live2D 依赖缺失：${path.basename(rawRelative)}`);
    if (!isAllowedLive2DPackagePath(file.archivePath)) throw new Error("Live2D 依赖文件类型不允许进入桌宠包。");
    if (selected.has(key)) return;
    selected.set(key, file);
    if (file.archivePath.toLowerCase().endsWith(".json")) jsonQueue.push(file);
  };
  addRelative(options.entryRelativePath);
  for (const relative of options.fallbackRelativePaths ?? []) addRelative(relative);
  while (jsonQueue.length) {
    const file = jsonQueue.shift()!;
    if (file.size > maximumJsonBytes) throw new Error("Live2D JSON 文件超出安全限制。");
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.readFile(file.sourcePath, "utf8")); }
    catch { throw new Error(`Live2D JSON 无法解析：${path.basename(file.sourcePath)}`); }
    for (const reference of collectFileLikeStrings(parsed)) addRelative(reference, path.dirname(file.sourcePath));
  }
  return [...selected.values()].sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

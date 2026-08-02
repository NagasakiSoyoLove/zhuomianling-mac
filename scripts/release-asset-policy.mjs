const forbiddenSuffixes = [
  ".moc",
  ".moc3",
  ".model3.json",
  ".motion3.json",
  ".exp3.json",
  ".mtn",
  ".exp.json",
  ".pth",
  ".ckpt",
  ".onnx",
  ".safetensors",
  ".whl",
  ".sqlite",
  ".sqlite3",
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".aac",
  ".local.json",
  ".bak",
  ".tmp",
  ".test.js",
  ".spec.js"
];
const forbiddenFileNames = new Set([
  "pet.local.json",
  "ai-connections.json",
  "secure-secrets.json",
  "speech.local.json",
  "gpt-sovits.generated.yaml",
  ".desktop-pet-import-transaction.json"
]);
const forbiddenPathSegments = [
  "/.cache/",
  "/memory-sidecar/",
  "/gpt-sovits/",
  "/voice-model/",
  "/reference-audio/",
  "/.live2d-staging-",
  "/.live2d-backup-"
];

export function normalizeReleasePath(filePath) {
  return `/${String(filePath).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()}`;
}

export function isForbiddenReleasePath(filePath) {
  const normalizedPath = normalizeReleasePath(filePath);
  const fileName = normalizedPath.split("/").pop() ?? "";

  return (
    normalizedPath === "/dist/renderer/live2d" ||
    normalizedPath.startsWith("/dist/renderer/live2d/") ||
    forbiddenFileNames.has(fileName) ||
    forbiddenSuffixes.some((suffix) => fileName.endsWith(suffix)) ||
    forbiddenPathSegments.some((segment) => normalizedPath.includes(segment))
  );
}

export function isProductionNodeModulePath(filePath) {
  const normalizedPath = normalizeReleasePath(filePath);
  const approvedPaths = new Set([
    "/node_modules",
    "/node_modules/buffer-crc32",
    "/node_modules/buffer-crc32/license",
    "/node_modules/buffer-crc32/dist",
    "/node_modules/buffer-crc32/dist/index.cjs",
    "/node_modules/buffer-crc32/dist/index.mjs",
    "/node_modules/buffer-crc32/package.json",
    "/node_modules/pend",
    "/node_modules/pend/license",
    "/node_modules/pend/index.js",
    "/node_modules/pend/package.json",
    "/node_modules/yauzl",
    "/node_modules/yauzl/license",
    "/node_modules/yauzl/crc32.js",
    "/node_modules/yauzl/fd-slicer.js",
    "/node_modules/yauzl/index.js",
    "/node_modules/yauzl/package.json",
    "/node_modules/yazl",
    "/node_modules/yazl/license",
    "/node_modules/yazl/index.js",
    "/node_modules/yazl/package.json"
  ]);

  return normalizedPath.startsWith("/node_modules") && !approvedPaths.has(normalizedPath);
}

import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";

const localHelpHost = "127.0.0.1";
const localHelpEntry = "help.html";

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

let localHelpServer: Server | undefined;
let localHelpServerUrl: Promise<string> | undefined;

function sendPlainResponse(response: ServerResponse, statusCode: number, message: string): void {
  const body = Buffer.from(message, "utf8");
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function isAllowedHelpPath(relativePath: string): boolean {
  if (relativePath === localHelpEntry) {
    return true;
  }

  if (!relativePath.startsWith("assets/") || relativePath.includes("\\")) {
    return false;
  }

  return !relativePath.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function serveHelpRequest(
  helpRoot: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendPlainResponse(response, 405, "Method Not Allowed");
    return;
  }

  let relativePath: string;

  try {
    const requestUrl = new URL(request.url ?? "/", `http://${localHelpHost}`);
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    relativePath = decodedPath === "/" ? localHelpEntry : decodedPath.replace(/^\/+/, "");
  } catch {
    sendPlainResponse(response, 400, "Bad Request");
    return;
  }

  if (!isAllowedHelpPath(relativePath)) {
    sendPlainResponse(response, 404, "Not Found");
    return;
  }

  const helpRootPath = path.resolve(helpRoot);
  const targetPath = path.resolve(helpRootPath, ...relativePath.split("/"));
  const relativeTargetPath = path.relative(helpRootPath, targetPath);

  if (relativeTargetPath.startsWith("..") || path.isAbsolute(relativeTargetPath)) {
    sendPlainResponse(response, 404, "Not Found");
    return;
  }

  try {
    const fileStats = await stat(targetPath);
    if (!fileStats.isFile()) {
      sendPlainResponse(response, 404, "Not Found");
      return;
    }

    const body = await readFile(targetPath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.byteLength,
      "Content-Type": contentTypes[path.extname(targetPath).toLowerCase()] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    sendPlainResponse(response, 404, "Not Found");
  }
}

export async function startLocalHelpServer(helpRoot: string): Promise<string> {
  if (localHelpServerUrl) {
    return localHelpServerUrl;
  }

  const resolvedHelpRoot = path.resolve(helpRoot);
  const entryPath = path.join(resolvedHelpRoot, localHelpEntry);

  try {
    const entryStats = await stat(entryPath);
    if (!entryStats.isFile()) {
      throw new Error("The local tutorial entry is not a file.");
    }
  } catch (error: unknown) {
    throw new Error(
      `The local tutorial entry is unavailable: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  const serverUrlPromise = new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      void serveHelpRequest(resolvedHelpRoot, request, response);
    });

    localHelpServer = server;

    const handleError = (error: Error): void => {
      if (localHelpServer === server) {
        localHelpServer = undefined;
      }
      reject(error);
    };

    server.once("error", handleError);
    server.listen(0, localHelpHost, () => {
      server.off("error", handleError);
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("The local tutorial server did not expose a TCP port."));
        return;
      }

      resolve(`http://${localHelpHost}:${address.port}`);
    });
  });

  localHelpServerUrl = serverUrlPromise.catch((error: unknown) => {
    localHelpServerUrl = undefined;
    throw error;
  });

  return localHelpServerUrl;
}

export async function stopLocalHelpServer(): Promise<void> {
  const server = localHelpServer;
  localHelpServer = undefined;
  localHelpServerUrl = undefined;

  if (!server) {
    return;
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

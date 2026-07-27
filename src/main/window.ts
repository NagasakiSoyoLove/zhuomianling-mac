import { BrowserWindow, Menu, systemPreferences } from "electron";
import path from "node:path";
import { getAppIconPath } from "./appIcon";
import { hardenWindowNavigation } from "./windowSecurity";
import { startupProfiler } from "./startupProfiler";

let startupSurfaceWindow: BrowserWindow | undefined;
let hasRevealedStartupSurface = false;
let hasSentStartupShownEvent = false;
let fallbackShowTimer: NodeJS.Timeout | undefined;

const mainWindowCloseAnimationMs = 170;
const mainWindowCloseFrameMs = 16;

function shouldAnimateMainWindowClose(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  try {
    const animationSettings = systemPreferences.getAnimationSettings();
    return animationSettings.shouldRenderRichAnimation && !animationSettings.prefersReducedMotion;
  } catch {
    return true;
  }
}

export async function hideMainWindowForShutdown(targetWindow: BrowserWindow): Promise<void> {
  if (targetWindow.isDestroyed()) {
    return;
  }

  if (!targetWindow.isVisible() || !shouldAnimateMainWindowClose()) {
    targetWindow.hide();
    return;
  }

  const startedAt = performance.now();

  await new Promise<void>((resolve) => {
    const animateFrame = (): void => {
      if (targetWindow.isDestroyed()) {
        resolve();
        return;
      }

      const progress = Math.min(1, (performance.now() - startedAt) / mainWindowCloseAnimationMs);
      targetWindow.setOpacity(Math.max(0, 1 - progress * progress));

      if (progress >= 1) {
        resolve();
        return;
      }

      setTimeout(animateFrame, mainWindowCloseFrameMs);
    };

    animateFrame();
  });

  if (!targetWindow.isDestroyed()) {
    targetWindow.hide();
    targetWindow.setOpacity(1);
  }
}

function clearFallbackShowTimer(): void {
  if (!fallbackShowTimer) {
    return;
  }

  clearTimeout(fallbackShowTimer);
  fallbackShowTimer = undefined;
}

export function revealMainWindowStartupSurface(_reason?: string): void {
  const targetWindow = startupSurfaceWindow;

  if (!targetWindow || targetWindow.isDestroyed() || hasRevealedStartupSurface) {
    return;
  }

  hasRevealedStartupSurface = true;
  clearFallbackShowTimer();

  targetWindow.setOpacity(1);

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (!hasSentStartupShownEvent && targetWindow.isVisible()) {
    hasSentStartupShownEvent = true;
    targetWindow.webContents.send("app-window:shown");
  }
  startupProfiler.markOnce("main-window-revealed", "主窗口首帧已显示");
}

export function createMainWindow(): BrowserWindow {
  Menu.setApplicationMenu(null);

  const preloadPath = path.join(__dirname, "../preload/index.js");

  const mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 920,
    minHeight: 600,
    show: false,
    opacity: 0,
    title: "桌面灵",
    icon: getAppIconPath(),
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false
    }
  });
  hardenWindowNavigation(mainWindow);
  mainWindow.webContents.once("did-start-loading", () => {
    startupProfiler.markOnce("renderer-loading-started", "渲染页面开始加载");
  });
  mainWindow.webContents.once("dom-ready", () => {
    startupProfiler.markOnce("renderer-dom-ready", "渲染页面 DOM ready");
  });
  mainWindow.webContents.once("did-finish-load", () => {
    startupProfiler.markOnce("renderer-load-finished", "渲染页面 did-finish-load");
  });
  startupSurfaceWindow = mainWindow;
  hasRevealedStartupSurface = false;
  hasSentStartupShownEvent = false;

  mainWindow.once("closed", () => {
    if (startupSurfaceWindow === mainWindow) {
      startupSurfaceWindow = undefined;
      clearFallbackShowTimer();
    }
  });

  const forceShowMainWindow = (): void => {
    clearFallbackShowTimer();

    if (mainWindow.isDestroyed()) {
      return;
    }

    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }

    if (!hasSentStartupShownEvent && mainWindow.isVisible()) {
      hasSentStartupShownEvent = true;
      mainWindow.webContents.send("app-window:shown");
    }
  };

  clearFallbackShowTimer();
  fallbackShowTimer = setTimeout(() => {
    fallbackShowTimer = undefined;
    startupProfiler.markOnce("main-window-show-fallback", "主窗口触发 3 秒兜底显示");
    forceShowMainWindow();
    revealMainWindowStartupSurface("show fallback");
  }, 3000);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, "../renderer/index.html");
    void mainWindow.loadFile(indexPath);
  }

  return mainWindow;
}

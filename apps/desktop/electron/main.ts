import path from "node:path";
import { app, BrowserWindow, desktopCapturer, ipcMain } from "electron";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("ohmcord:get-desktop-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 640, height: 360 }
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith("window:") ? "window" : "screen",
      previewDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL()
    }));
  });

  ipcMain.handle("ohmcord:get-desktop-source-id", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 }
    });
    const source = sources[0];
    if (!source) throw new Error("No display source available");
    return source.id;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});


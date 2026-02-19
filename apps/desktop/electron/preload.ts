import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ohmcord", {
  version: "0.1.0",
  getDesktopSources: () => ipcRenderer.invoke("ohmcord:get-desktop-sources"),
  getDesktopSourceId: () => ipcRenderer.invoke("ohmcord:get-desktop-source-id")
});


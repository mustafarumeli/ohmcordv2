import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("ohmcord", {
  version: "0.1.0"
});


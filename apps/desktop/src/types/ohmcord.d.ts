declare global {
  interface Window {
    ohmcord?: {
      version: string;
      getDesktopSources?: () => Promise<Array<{ id: string; name: string; kind: "screen" | "window"; previewDataUrl: string | null }>>;
      getDesktopSourceId?: () => Promise<string>;
    };
  }
}

export {};

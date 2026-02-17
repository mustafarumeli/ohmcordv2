import type { ClientToServer, ServerToClient } from "../shared/protocol";

export type SignalingEvents = {
  onMessage: (msg: ServerToClient) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private events: SignalingEvents;

  constructor(url: string, events: SignalingEvents) {
    this.url = url;
    this.events = events;
  }

  connect() {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => this.events.onOpen?.());
    ws.addEventListener("close", () => {
      this.ws = null;
      this.events.onClose?.();
    });
    ws.addEventListener("error", (e) => this.events.onError?.(e));
    ws.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as ServerToClient;
        this.events.onMessage(msg);
      } catch {
        // ignore
      }
    });
  }

  disconnect() {
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  send(msg: ClientToServer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }
}


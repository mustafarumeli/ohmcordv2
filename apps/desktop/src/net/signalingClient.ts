import type { ClientToServer, ServerToClient } from "../shared/protocol";

export type SignalingEvents = {
  onMessage: (msg: ServerToClient) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  onSend?: (msg: ClientToServer) => void;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private events: SignalingEvents;
  private intentionalClose = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;

  constructor(url: string, events: SignalingEvents) {
    this.url = url;
    this.events = events;
  }

  connect() {
    if (this.ws) return;
    this.intentionalClose = false;
    this.createWebSocket();
  }

  private createWebSocket() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      if (this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.events.onOpen?.();
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.events.onClose?.();
      if (!this.intentionalClose) this.scheduleReconnect();
    });

    ws.addEventListener("error", (e) => {
      // Keep the error surfaced, but rely on "close" to trigger reconnect.
      this.events.onError?.(e);
    });

    ws.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as ServerToClient;
        this.events.onMessage(msg);
      } catch {
        // ignore
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempts;
    const base = Math.min(1000 * Math.pow(2, attempt), 10_000);
    const jitter = Math.floor(Math.random() * 250);
    const delay = base + jitter;
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      if (this.ws) return;
      this.createWebSocket();
    }, delay);
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  send(msg: ClientToServer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.events.onSend?.(msg);
    this.ws.send(JSON.stringify(msg));
  }
}


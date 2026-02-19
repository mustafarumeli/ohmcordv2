import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ClientToServer } from "./protocol.js";
import type { PeerSummary, ServerToClient } from "./protocol.js";
import { deleteRoomIfEmpty, getOrCreateRoom, getRoom, removeWatcherFromAllRooms } from "./rooms.js";
import type { Client } from "./rooms.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8080);

function send(ws: { send: (data: string) => void }, msg: ServerToClient) {
  ws.send(JSON.stringify(msg));
}

function safeParseMessage(raw: unknown) {
  if (typeof raw !== "string") return null;
  try {
    const json = JSON.parse(raw);
    const parsed = ClientToServer.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toPeerSummary(client: Client): PeerSummary {
  return {
    peerId: client.peerId,
    displayName: client.displayName,
    micOn: client.micOn,
    deafened: client.deafened
  };
}

function roomRecipients(room: { clients: Map<string, Client>; watchers: Map<string, Client> }) {
  const recipients = new Map<string, Client>();
  for (const c of room.clients.values()) recipients.set(c.peerId, c);
  for (const w of room.watchers.values()) recipients.set(w.peerId, w);
  return recipients;
}

function leaveCurrentRoom(client: Client) {
  if (!client.roomId) return;
  const room = getRoom(client.roomId);
  if (!room) {
    client.roomId = null;
    return;
  }

  room.clients.delete(client.peerId);
  for (const other of room.clients.values()) {
    send(other.ws, { type: "peer-left", roomId: room.roomId, peerId: client.peerId });
  }
  for (const other of roomRecipients(room).values()) {
    if (other.peerId === client.peerId) continue;
    send(other.ws, { type: "room-peer-left", roomId: room.roomId, peerId: client.peerId });
  }
  const leavingRoomId = room.roomId;
  client.roomId = null;
  deleteRoomIfEmpty(leavingRoomId);
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const peerId = randomUUID();
  const client: Client = {
    ws,
    peerId,
    displayName: "Anonymous",
    roomId: null,
    micOn: false,
    deafened: false
  };

  send(ws, { type: "welcome", peerId });

  ws.on("message", (data) => {
    const msg = safeParseMessage(data.toString());
    if (!msg) return;

    if (msg.type === "join") {
      leaveCurrentRoom(client);

      client.displayName = msg.user.displayName;
      client.roomId = msg.roomId;

      const room = getOrCreateRoom(msg.roomId);
      room.clients.set(client.peerId, client);

      const peers: PeerSummary[] = [...room.clients.values()]
        .filter((c) => c.peerId !== client.peerId)
        .map(toPeerSummary);

      send(ws, { type: "peers", roomId: room.roomId, peers });

      for (const other of room.clients.values()) {
        if (other.peerId === client.peerId) continue;
        send(other.ws, {
          type: "peer-joined",
          roomId: room.roomId,
          peer: toPeerSummary(client)
        });
      }
      for (const other of roomRecipients(room).values()) {
        if (other.peerId === client.peerId) continue;
        send(other.ws, {
          type: "room-peer-joined",
          roomId: room.roomId,
          peer: toPeerSummary(client)
        });
      }

      return;
    }

    if (msg.type === "watch") {
      const room = getOrCreateRoom(msg.roomId);
      room.watchers.set(client.peerId, client);
      const peers: PeerSummary[] = [...room.clients.values()].map(toPeerSummary);
      send(ws, { type: "room-peers", roomId: room.roomId, peers });
      return;
    }

    if (msg.type === "unwatch") {
      const room = getRoom(msg.roomId);
      if (!room) return;
      room.watchers.delete(client.peerId);
      deleteRoomIfEmpty(room.roomId);
      return;
    }

    if (msg.type === "state") {
      if (!client.roomId) return;
      const room = getRoom(client.roomId);
      if (!room) return;
      if (msg.roomId !== room.roomId) return;
      client.micOn = msg.micOn;
      client.deafened = msg.deafened;
      for (const other of roomRecipients(room).values()) {
        if (other.peerId === client.peerId) continue;
        send(other.ws, {
          type: "peer-state",
          roomId: room.roomId,
          peerId: client.peerId,
          micOn: client.micOn,
          deafened: client.deafened
        });
      }
      return;
    }

    if (msg.type === "leave") {
      leaveCurrentRoom(client);
      return;
    }

    // Everything else requires room membership
    if (!client.roomId) return;
    const room = getRoom(client.roomId);
    if (!room) return;

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      const target = room.clients.get(msg.to);
      if (!target) return;

      if (msg.type === "offer") {
        send(target.ws, { type: "offer", from: client.peerId, sdp: msg.sdp });
      } else if (msg.type === "answer") {
        send(target.ws, { type: "answer", from: client.peerId, sdp: msg.sdp });
      } else {
        send(target.ws, { type: "ice", from: client.peerId, candidate: msg.candidate });
      }
      return;
    }

    if (msg.type === "text") {
      // Allow only messages for current roomId to keep protocol simple
      if (msg.roomId !== room.roomId) return;

      const payload: ServerToClient = {
        type: "text",
        roomId: msg.roomId,
        channelId: msg.channelId,
        from: toPeerSummary(client),
        message: msg.message,
        ts: Date.now()
      };
      for (const other of room.clients.values()) send(other.ws, payload);
      return;
    }

    if (msg.type === "vad") {
      if (msg.roomId !== room.roomId) return;
      const payload: ServerToClient = {
        type: "vad",
        roomId: room.roomId,
        from: client.peerId,
        speaking: msg.speaking
      };
      for (const other of room.clients.values()) {
        if (other.peerId === client.peerId) continue;
        send(other.ws, payload);
      }
      return;
    }
  });

  ws.on("close", () => {
    leaveCurrentRoom(client);
    removeWatcherFromAllRooms(client.peerId);
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  const advertisedHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`[ohmcord-server] ws://${advertisedHost}:${PORT}`);
});


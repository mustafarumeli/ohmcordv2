import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ClientToServer } from "./protocol.js";
import type { PeerSummary, ServerToClient } from "./protocol.js";
import { deleteRoomIfEmpty, getOrCreateRoom, getRoom } from "./rooms.js";
import type { Client } from "./rooms.js";

const PORT = Number(process.env.PORT ?? 8787);

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

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const peerId = randomUUID();
  const client: Client = {
    ws,
    peerId,
    displayName: "Anonymous",
    roomId: null
  };

  send(ws, { type: "welcome", peerId });

  ws.on("message", (data) => {
    const msg = safeParseMessage(data.toString());
    if (!msg) return;

    if (msg.type === "join") {
      // leave previous room (if any)
      if (client.roomId) {
        const prevRoom = getRoom(client.roomId);
        if (prevRoom) {
          prevRoom.clients.delete(client.peerId);
          for (const other of prevRoom.clients.values()) {
            send(other.ws, {
              type: "peer-left",
              roomId: prevRoom.roomId,
              peerId: client.peerId
            });
          }
          deleteRoomIfEmpty(prevRoom.roomId);
        }
      }

      client.displayName = msg.user.displayName;
      client.roomId = msg.roomId;

      const room = getOrCreateRoom(msg.roomId);
      room.clients.set(client.peerId, client);

      const peers: PeerSummary[] = [...room.clients.values()]
        .filter((c) => c.peerId !== client.peerId)
        .map((c) => ({ peerId: c.peerId, displayName: c.displayName }));

      send(ws, { type: "peers", roomId: room.roomId, peers });

      for (const other of room.clients.values()) {
        if (other.peerId === client.peerId) continue;
        send(other.ws, {
          type: "peer-joined",
          roomId: room.roomId,
          peer: { peerId: client.peerId, displayName: client.displayName }
        });
      }

      return;
    }

    if (msg.type === "leave") {
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
      const leavingRoomId = room.roomId;
      client.roomId = null;
      deleteRoomIfEmpty(leavingRoomId);
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
        from: { peerId: client.peerId, displayName: client.displayName },
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
    if (!client.roomId) return;
    const room = getRoom(client.roomId);
    if (!room) return;
    room.clients.delete(client.peerId);
    for (const other of room.clients.values()) {
      send(other.ws, { type: "peer-left", roomId: room.roomId, peerId: client.peerId });
    }
    const roomId = room.roomId;
    client.roomId = null;
    deleteRoomIfEmpty(roomId);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ohmcord-server] ws://localhost:${PORT}`);
});


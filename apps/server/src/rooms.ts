import type { WebSocket } from "ws";

export type Client = {
  ws: WebSocket;
  peerId: string;
  displayName: string;
  roomId: string | null;
};

type Room = {
  roomId: string;
  clients: Map<string, Client>;
};

const rooms = new Map<string, Room>();

export function getOrCreateRoom(roomId: string): Room {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const room: Room = { roomId, clients: new Map() };
  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function deleteRoomIfEmpty(roomId: string) {
  const room = rooms.get(roomId);
  if (room && room.clients.size === 0) {
    rooms.delete(roomId);
  }
}


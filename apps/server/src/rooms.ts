import type { WebSocket } from "ws";

export type Client = {
  ws: WebSocket;
  peerId: string;
  displayName: string;
  roomId: string | null;
  micOn: boolean;
  deafened: boolean;
};

type Room = {
  roomId: string;
  clients: Map<string, Client>;
  watchers: Map<string, Client>;
};

const rooms = new Map<string, Room>();

export function getOrCreateRoom(roomId: string): Room {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const room: Room = { roomId, clients: new Map(), watchers: new Map() };
  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function deleteRoomIfEmpty(roomId: string) {
  const room = rooms.get(roomId);
  if (room && room.clients.size === 0 && room.watchers.size === 0) {
    rooms.delete(roomId);
  }
}

export function removeWatcherFromAllRooms(peerId: string) {
  for (const room of rooms.values()) {
    room.watchers.delete(peerId);
    deleteRoomIfEmpty(room.roomId);
  }
}


export type PeerSummary = {
  peerId: string;
  displayName: string;
  micOn: boolean;
  deafened: boolean;
};

export type ClientToServer =
  | {
      type: "join";
      roomId: string;
      user: { displayName: string };
    }
  | { type: "watch"; roomId: string }
  | { type: "unwatch"; roomId: string }
  | { type: "leave" }
  | { type: "state"; roomId: string; micOn: boolean; deafened: boolean }
  | { type: "offer"; to: string; sdp: string }
  | { type: "answer"; to: string; sdp: string }
  | { type: "ice"; to: string; candidate: unknown }
  | { type: "text"; roomId: string; channelId: string; message: string }
  | { type: "vad"; roomId: string; speaking: boolean };

export type ServerToClient =
  | { type: "welcome"; peerId: string }
  | { type: "peers"; roomId: string; peers: PeerSummary[] }
  | { type: "room-peers"; roomId: string; peers: PeerSummary[] }
  | { type: "peer-joined"; roomId: string; peer: PeerSummary }
  | { type: "room-peer-joined"; roomId: string; peer: PeerSummary }
  | { type: "peer-left"; roomId: string; peerId: string }
  | { type: "room-peer-left"; roomId: string; peerId: string }
  | { type: "peer-state"; roomId: string; peerId: string; micOn: boolean; deafened: boolean }
  | { type: "offer"; from: string; sdp: string }
  | { type: "answer"; from: string; sdp: string }
  | { type: "ice"; from: string; candidate: unknown }
  | { type: "text"; roomId: string; channelId: string; from: PeerSummary; message: string; ts: number }
  | { type: "vad"; roomId: string; from: string; speaking: boolean };


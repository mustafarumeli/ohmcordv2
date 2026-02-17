import { z } from "zod";

export const RoomId = z.string().min(1).max(64);
export const ChannelId = z.string().min(1).max(64);
export const PeerId = z.string().min(1).max(128);

export const ClientToServer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    roomId: RoomId,
    user: z.object({
      displayName: z.string().min(1).max(64)
    })
  }),
  z.object({
    type: z.literal("leave")
  }),
  z.object({
    type: z.literal("offer"),
    to: PeerId,
    sdp: z.string().min(1)
  }),
  z.object({
    type: z.literal("answer"),
    to: PeerId,
    sdp: z.string().min(1)
  }),
  z.object({
    type: z.literal("ice"),
    to: PeerId,
    candidate: z.unknown()
  }),
  z.object({
    type: z.literal("text"),
    roomId: RoomId,
    channelId: ChannelId,
    message: z.string().min(1).max(4000)
  }),
  z.object({
    type: z.literal("vad"),
    roomId: RoomId,
    speaking: z.boolean()
  })
]);

export type ClientToServer = z.infer<typeof ClientToServer>;

export type PeerSummary = {
  peerId: string;
  displayName: string;
};

export type ServerToClient =
  | {
      type: "welcome";
      peerId: string;
    }
  | {
      type: "peers";
      roomId: string;
      peers: PeerSummary[];
    }
  | {
      type: "peer-joined";
      roomId: string;
      peer: PeerSummary;
    }
  | {
      type: "peer-left";
      roomId: string;
      peerId: string;
    }
  | {
      type: "offer";
      from: string;
      sdp: string;
    }
  | {
      type: "answer";
      from: string;
      sdp: string;
    }
  | {
      type: "ice";
      from: string;
      candidate: unknown;
    }
  | {
      type: "text";
      roomId: string;
      channelId: string;
      from: PeerSummary;
      message: string;
      ts: number;
    }
  | {
      type: "vad";
      roomId: string;
      from: string;
      speaking: boolean;
    };


import type { SignalingClient } from "../net/signalingClient";
import type { ServerToClient } from "../shared/protocol";

export type PeerInfo = {
  peerId: string;
  displayName: string;
};

function buildIceServers(): RTCIceServer[] {
  const stunUrls: string[] = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
    "stun:stun.ekiga.net",
    "stun:stun.ideasip.com",
    "stun:stun.rixtelecom.se",
    "stun:stun.schlund.de",
    "stun:stun.stunprotocol.org:3478",
    "stun:stun.voiparound.com",
    "stun:stun.voipbuster.com",
    "stun:stun.voipstunt.com",
    "stun:stun.voxgratia.org"
  ];

  const urlsRaw = (import.meta as any).env?.VITE_TURN_URLS as string | undefined;
  const username = (import.meta as any).env?.VITE_TURN_USERNAME as string | undefined;
  const credential = (import.meta as any).env?.VITE_TURN_CREDENTIAL as string | undefined;

  const urls = (urlsRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If TURN is configured, use only TURN (no STUN fallback).
  if (urls.length > 0 && username && credential) {
    return [{ urls, username, credential }];
  }

  return [{ urls: stunUrls }];
}

export type PeerMediaEventHandlers = {
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onPeerConnState?: (peerId: string, state: RTCPeerConnectionState, ice: RTCIceConnectionState) => void;
  onRemoteAudioTrack?: (peerId: string, track: MediaStreamTrack, stream: MediaStream) => void;
  onRemoteVideoTrack?: (peerId: string, track: MediaStreamTrack, stream: MediaStream) => void;
  onPeerVad?: (peerId: string, speaking: boolean) => void;
};

type SenderSlot = "micAudio" | "screenAudio" | "screenVideo";

type PeerConn = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  displayName: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  needsNegotiation: boolean;
  senders: Partial<Record<SenderSlot, RTCRtpSender>>;
};

export class PeerMesh {
  private signaling: SignalingClient;
  private roomId: string;
  private localPeerId: string;
  private peers = new Map<string, PeerConn>();
  private handlers: PeerMediaEventHandlers;
  private localAudioTrack: MediaStreamTrack | null = null;
  private localScreenTrack: MediaStreamTrack | null = null;
  private localScreenAudioTrack: MediaStreamTrack | null = null;
  private localScreenStream: MediaStream | null = null;

  constructor(opts: {
    signaling: SignalingClient;
    roomId: string;
    localPeerId: string;
    handlers: PeerMediaEventHandlers;
  }) {
    this.signaling = opts.signaling;
    this.roomId = opts.roomId;
    this.localPeerId = opts.localPeerId;
    this.handlers = opts.handlers;
  }

  closeAll() {
    for (const [peerId, peer] of this.peers) {
      peer.dc?.close();
      peer.pc.close();
      this.peers.delete(peerId);
      this.handlers.onPeerDisconnected?.(peerId);
    }
  }

  setLocalAudioTrack(track: MediaStreamTrack | null) {
    this.localAudioTrack = track;
    for (const [peerId, peer] of this.peers) {
      this.upsertSender(peer, "micAudio", track, null);
      // Force renegotiation when tracks change (more reliable than waiting on negotiationneeded).
      void this.negotiate(peerId);
    }
  }

  setLocalScreenMedia(stream: MediaStream | null) {
    this.localScreenStream = stream;
    this.localScreenTrack = stream?.getVideoTracks()[0] ?? null;
    this.localScreenAudioTrack = stream?.getAudioTracks()[0] ?? null;
    for (const [peerId, peer] of this.peers) {
      this.upsertSender(peer, "screenVideo", this.localScreenTrack, this.localScreenStream);
      this.upsertSender(peer, "screenAudio", this.localScreenAudioTrack, this.localScreenStream);
      void this.negotiate(peerId);
    }
  }

  broadcastVad(speaking: boolean) {
    const payload = JSON.stringify({ type: "vad", speaking });
    for (const peer of this.peers.values()) {
      if (peer.dc?.readyState === "open") peer.dc.send(payload);
    }
  }

  ensurePeer(peer: PeerInfo, initiator: boolean) {
    if (this.peers.has(peer.peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: buildIceServers()
    });

    pc.onicecandidate = (evt) => {
      if (!evt.candidate) return;
      this.signaling.send({ type: "ice", to: peer.peerId, candidate: evt.candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      await this.negotiate(peer.peerId);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.handlers.onPeerConnected?.(peer.peerId);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        // keep it simple: let higher layers decide retry; here just notify
      }
      this.handlers.onPeerConnState?.(peer.peerId, pc.connectionState, pc.iceConnectionState);
    };

    pc.oniceconnectionstatechange = () => {
      this.handlers.onPeerConnState?.(peer.peerId, pc.connectionState, pc.iceConnectionState);
    };

    pc.ontrack = (evt) => {
      const [stream] = evt.streams;
      const track = evt.track;
      const remoteStream = stream ?? new MediaStream([track]);
      if (track.kind === "audio") this.handlers.onRemoteAudioTrack?.(peer.peerId, track, remoteStream);
      if (track.kind === "video") this.handlers.onRemoteVideoTrack?.(peer.peerId, track, remoteStream);
      // ensure tracks stop cleanup is handled by consumer
      void remoteStream;
    };

    pc.ondatachannel = (evt) => {
      const dc = evt.channel;
      this.bindDataChannel(peer.peerId, dc);
      const conn = this.peers.get(peer.peerId);
      if (conn) conn.dc = dc;
    };

    const conn: PeerConn = {
      pc,
      displayName: peer.displayName,
      polite: this.localPeerId.localeCompare(peer.peerId) < 0,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      needsNegotiation: false,
      senders: {}
    };
    // add local tracks if available
    this.upsertSender(conn, "micAudio", this.localAudioTrack, null);
    this.upsertSender(conn, "screenVideo", this.localScreenTrack, this.localScreenStream);
    this.upsertSender(conn, "screenAudio", this.localScreenAudioTrack, this.localScreenStream);

    this.peers.set(peer.peerId, conn);
    this.handlers.onPeerConnState?.(peer.peerId, pc.connectionState, pc.iceConnectionState);

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable" && conn.needsNegotiation) {
        conn.needsNegotiation = false;
        void this.negotiate(peer.peerId);
      }
    };

    if (initiator) {
      const dc = pc.createDataChannel("ohmcord");
      conn.dc = dc;
      this.bindDataChannel(peer.peerId, dc);
      // Do not rely solely on onnegotiationneeded; some peers may miss it.
      // Force initial offer for initiator peers.
      void this.negotiate(peer.peerId);
    }
  }

  private bindDataChannel(peerId: string, dc: RTCDataChannel) {
    dc.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as { type: string; speaking?: boolean };
        if (msg.type === "vad" && typeof msg.speaking === "boolean") {
          this.handlers.onPeerVad?.(peerId, msg.speaking);
        }
      } catch {
        // ignore
      }
    };
  }

  private upsertSender(peer: PeerConn, slot: SenderSlot, track: MediaStreamTrack | null, stream: MediaStream | null) {
    const sender = peer.senders[slot];
    if (!track) {
      if (sender) {
        peer.pc.removeTrack(sender);
        peer.senders[slot] = undefined;
      }
      return;
    }
    if (sender) {
      void sender.replaceTrack(track);
      return;
    }
    peer.senders[slot] = peer.pc.addTrack(track, stream ?? new MediaStream([track]));
  }

  private async negotiate(peerId: string) {
    const conn = this.peers.get(peerId);
    if (!conn) return;
    const pc = conn.pc;
    if (conn.makingOffer) return;
    if (pc.signalingState !== "stable") {
      conn.needsNegotiation = true;
      return;
    }
    try {
      conn.makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({ type: "offer", to: peerId, sdp: pc.localDescription?.sdp ?? "" });
    } catch {
      // ignore
    } finally {
      conn.makingOffer = false;
    }
  }

  async handleSignaling(msg: ServerToClient) {
    if (msg.type === "peers") {
      for (const peer of msg.peers) {
        // joiner initiates offers to existing peers
        this.ensurePeer(peer, true);
      }
      return;
    }

    if (msg.type === "peer-joined") {
      // new peer will initiate, but create RTCPeerConnection ready to accept offer
      this.ensurePeer(msg.peer, false);
      return;
    }

    if (msg.type === "peer-left") {
      const conn = this.peers.get(msg.peerId);
      if (conn) {
        conn.dc?.close();
        conn.pc.close();
        this.peers.delete(msg.peerId);
        this.handlers.onPeerDisconnected?.(msg.peerId);
      }
      return;
    }

    if (msg.type === "offer") {
      this.ensurePeer({ peerId: msg.from, displayName: msg.from }, false);
      const conn = this.peers.get(msg.from);
      if (!conn) return;
      const pc = conn.pc;
      const description: RTCSessionDescriptionInit = { type: "offer", sdp: msg.sdp };
      const offerCollision = conn.makingOffer || pc.signalingState !== "stable";
      conn.ignoreOffer = !conn.polite && offerCollision;
      if (conn.ignoreOffer) return;
      try {
        if (offerCollision && conn.polite) {
          // Perfect-negotiation rollback path for polite peer.
          await Promise.all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(description)]);
        } else {
          await pc.setRemoteDescription(description);
        }
      } catch {
        return;
      }

      // Flush any queued ICE
      if (conn.pendingIce.length) {
        for (const cand of conn.pendingIce) {
          try {
            await pc.addIceCandidate(cand);
          } catch {
            // ignore
          }
        }
        conn.pendingIce = [];
      }

      try {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signaling.send({ type: "answer", to: msg.from, sdp: pc.localDescription?.sdp ?? "" });
      } catch {
        // ignore
      }
      return;
    }

    if (msg.type === "answer") {
      const conn = this.peers.get(msg.from);
      if (!conn) return;
      try {
        await conn.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } catch {
        // ignore
      }
      return;
    }

    if (msg.type === "ice") {
      const conn = this.peers.get(msg.from);
      if (!conn) return;
      const candidate = msg.candidate as RTCIceCandidateInit;
      const pc = conn.pc;
      if (conn.ignoreOffer) return;
      if (!pc.remoteDescription) {
        conn.pendingIce.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore
      }
      return;
    }
  }
}


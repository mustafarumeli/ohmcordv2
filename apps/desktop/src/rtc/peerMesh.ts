import type { SignalingClient } from "../net/signalingClient";
import type { ServerToClient } from "../shared/protocol";

export type PeerInfo = {
  peerId: string;
  displayName: string;
};

export type PeerMediaEventHandlers = {
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onRemoteAudioTrack?: (peerId: string, track: MediaStreamTrack) => void;
  onRemoteVideoTrack?: (peerId: string, track: MediaStreamTrack) => void;
  onPeerVad?: (peerId: string, speaking: boolean) => void;
};

type PeerConn = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  displayName: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
};

export class PeerMesh {
  private signaling: SignalingClient;
  private roomId: string;
  private localPeerId: string;
  private peers = new Map<string, PeerConn>();
  private handlers: PeerMediaEventHandlers;
  private localAudioTrack: MediaStreamTrack | null = null;
  private localScreenTrack: MediaStreamTrack | null = null;

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
    for (const peer of this.peers.values()) {
      this.upsertSender(peer.pc, "audio", track);
    }
  }

  setLocalScreenTrack(track: MediaStreamTrack | null) {
    this.localScreenTrack = track;
    for (const peer of this.peers.values()) {
      this.upsertSender(peer.pc, "video", track);
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
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
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
    };

    pc.ontrack = (evt) => {
      const [stream] = evt.streams;
      const track = evt.track;
      if (track.kind === "audio") this.handlers.onRemoteAudioTrack?.(peer.peerId, track);
      if (track.kind === "video") this.handlers.onRemoteVideoTrack?.(peer.peerId, track);
      // ensure tracks stop cleanup is handled by consumer
      void stream;
    };

    pc.ondatachannel = (evt) => {
      const dc = evt.channel;
      this.bindDataChannel(peer.peerId, dc);
      const conn = this.peers.get(peer.peerId);
      if (conn) conn.dc = dc;
    };

    // add local tracks if available
    this.upsertSender(pc, "audio", this.localAudioTrack);
    this.upsertSender(pc, "video", this.localScreenTrack);

    const conn: PeerConn = {
      pc,
      displayName: peer.displayName,
      polite: this.localPeerId.localeCompare(peer.peerId) < 0,
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: []
    };
    this.peers.set(peer.peerId, conn);

    if (initiator) {
      const dc = pc.createDataChannel("ohmcord");
      conn.dc = dc;
      this.bindDataChannel(peer.peerId, dc);
      // Initial negotiation will happen via onnegotiationneeded.
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

  private upsertSender(pc: RTCPeerConnection, kind: "audio" | "video", track: MediaStreamTrack | null) {
    const sender = pc.getSenders().find((s) => s.track?.kind === kind);
    if (!track) {
      if (sender) pc.removeTrack(sender);
      return;
    }
    if (sender) {
      void sender.replaceTrack(track);
      return;
    }
    pc.addTrack(track, new MediaStream([track]));
  }

  private async negotiate(peerId: string) {
    const conn = this.peers.get(peerId);
    if (!conn) return;
    const pc = conn.pc;
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

      await pc.setRemoteDescription(description);

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

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send({ type: "answer", to: msg.from, sdp: pc.localDescription?.sdp ?? "" });
      return;
    }

    if (msg.type === "answer") {
      const conn = this.peers.get(msg.from);
      if (!conn) return;
      await conn.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
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


import type { SignalingClient } from "../net/signalingClient";
import type { ServerToClient } from "../shared/protocol";

export type PeerInfo = {
  peerId: string;
  displayName: string;
};

function buildIceServers(): RTCIceServer[] {
  const stunUrls: string[] = [
    "stun:72.61.177.239:3478"
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

type PeerConn = {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  micAudioSender?: RTCRtpSender;
  screenAudioSender?: RTCRtpSender;
  screenVideoSender?: RTCRtpSender;
  displayName: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  needsNegotiation: boolean;
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
      const needsOffer = this.syncMicAudioSender(peer);
      if (needsOffer) void this.negotiate(peerId);
    }
  }

  setLocalScreenTrack(track: MediaStreamTrack | null) {
    this.localScreenStream = null;
    this.localScreenTrack = track;
    this.localScreenAudioTrack = null;
    for (const [peerId, peer] of this.peers) {
      const videoChanged = this.syncScreenVideoSender(peer);
      const audioChanged = this.syncScreenAudioSender(peer);
      if (videoChanged || audioChanged) void this.negotiate(peerId);
    }
  }

  setLocalScreenMedia(stream: MediaStream | null) {
    this.localScreenStream = stream;
    this.localScreenTrack = stream?.getVideoTracks()[0] ?? null;
    this.localScreenAudioTrack = stream?.getAudioTracks()[0] ?? null;
    for (const [peerId, peer] of this.peers) {
      const videoChanged = this.syncScreenVideoSender(peer);
      const audioChanged = this.syncScreenAudioSender(peer);
      if (videoChanged || audioChanged) void this.negotiate(peerId);
    }
  }

  broadcastVad(speaking: boolean) {
    const payload = JSON.stringify({ type: "vad", speaking });
    for (const peer of this.peers.values()) {
      if (peer.dc?.readyState === "open") peer.dc.send(payload);
    }
  }

  ensurePeer(peer: PeerInfo) {
    if (this.peers.has(peer.peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: buildIceServers()
    });

    pc.onicecandidate = (evt) => {
      if (!evt.candidate) return;
      this.signaling.send({ type: "ice", to: peer.peerId, candidate: evt.candidate.toJSON() });
    };

    // Avoid negotiation storms from noisy browser negotiationneeded events.
    // We negotiate explicitly when local sender topology changes.
    pc.onnegotiationneeded = null;

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
      const stream = evt.streams[0] ?? new MediaStream([evt.track]);
      const track = evt.track;
      if (track.kind === "audio") this.handlers.onRemoteAudioTrack?.(peer.peerId, track, stream);
      if (track.kind === "video") this.handlers.onRemoteVideoTrack?.(peer.peerId, track, stream);
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
      needsNegotiation: false
    };
    this.peers.set(peer.peerId, conn);
    this.syncMicAudioSender(conn);
    this.syncScreenAudioSender(conn);
    this.syncScreenVideoSender(conn);
    this.handlers.onPeerConnState?.(peer.peerId, pc.connectionState, pc.iceConnectionState);

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable" && conn.needsNegotiation) {
        conn.needsNegotiation = false;
        void this.negotiate(peer.peerId);
      }
    };

    // Deterministic initiator per pair prevents glare in multi-join races.
    const shouldInitiate = this.localPeerId.localeCompare(peer.peerId) < 0;
    if (shouldInitiate) {
      const dc = pc.createDataChannel("ohmcord");
      conn.dc = dc;
      this.bindDataChannel(peer.peerId, dc);
      // Force initial offer for the designated initiator.
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

  private syncMicAudioSender(conn: PeerConn): boolean {
    if (!this.localAudioTrack) {
      if (conn.micAudioSender) {
        conn.pc.removeTrack(conn.micAudioSender);
        conn.micAudioSender = undefined;
        return true;
      }
      return false;
    }
    if (conn.micAudioSender) {
      if (conn.micAudioSender.track?.id !== this.localAudioTrack.id) {
        void conn.micAudioSender.replaceTrack(this.localAudioTrack);
      }
      return false;
    }
    conn.micAudioSender = conn.pc.addTrack(this.localAudioTrack, new MediaStream([this.localAudioTrack]));
    return true;
  }

  private syncScreenAudioSender(conn: PeerConn): boolean {
    if (!this.localScreenAudioTrack) {
      if (conn.screenAudioSender) {
        conn.pc.removeTrack(conn.screenAudioSender);
        conn.screenAudioSender = undefined;
        return true;
      }
      return false;
    }
    if (conn.screenAudioSender) {
      if (conn.screenAudioSender.track?.id !== this.localScreenAudioTrack.id) {
        void conn.screenAudioSender.replaceTrack(this.localScreenAudioTrack);
      }
      return false;
    }
    conn.screenAudioSender = conn.pc.addTrack(
      this.localScreenAudioTrack,
      this.localScreenStream ?? new MediaStream([this.localScreenAudioTrack])
    );
    return true;
  }

  private syncScreenVideoSender(conn: PeerConn): boolean {
    if (!this.localScreenTrack) {
      if (conn.screenVideoSender) {
        conn.pc.removeTrack(conn.screenVideoSender);
        conn.screenVideoSender = undefined;
        return true;
      }
      return false;
    }
    if (conn.screenVideoSender) {
      if (conn.screenVideoSender.track?.id !== this.localScreenTrack.id) {
        void conn.screenVideoSender.replaceTrack(this.localScreenTrack);
      }
      return false;
    }
    conn.screenVideoSender = conn.pc.addTrack(this.localScreenTrack, this.localScreenStream ?? new MediaStream([this.localScreenTrack]));
    return true;
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
        this.ensurePeer(peer);
      }
      return;
    }

    if (msg.type === "peer-joined") {
      this.ensurePeer(msg.peer);
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
      this.ensurePeer({ peerId: msg.from, displayName: msg.from });
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


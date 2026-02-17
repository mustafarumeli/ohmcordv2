import React, { useEffect, useMemo, useRef, useState } from "react";
import { SignalingClient } from "../net/signalingClient";
import type { PeerSummary, ServerToClient } from "../shared/protocol";
import { PeerMesh } from "../rtc/peerMesh";
import { VoiceRing } from "./components/VoiceRing";
import { startVoicePipeline } from "../audio/voicePipeline";

type ChatMessage = {
  roomId: string;
  channelId: string;
  fromName: string;
  ts: number;
  message: string;
};

type Participant = PeerSummary & {
  speaking: boolean;
};

const DEFAULT_SERVER_URL = "ws://localhost:8787";
const DEFAULT_ROOM_ID = "friends";
const DEFAULT_CHANNEL_ID = "general";

export function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [displayName, setDisplayName] = useState(() => `User${Math.floor(Math.random() * 1000)}`);
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [channelId, setChannelId] = useState(DEFAULT_CHANNEL_ID);

  const [wsOpen, setWsOpen] = useState(false);
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);

  const [participants, setParticipants] = useState<Map<string, Participant>>(() => new Map());
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");

  const [voiceOn, setVoiceOn] = useState(false);
  const [rnnoiseOn, setRnnoiseOn] = useState(true);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>("default");
  const [lastError, setLastError] = useState<string | null>(null);

  const [screenOn, setScreenOn] = useState(false);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Map<string, MediaStream>>(() => new Map());
  const [remoteAudioStreams, setRemoteAudioStreams] = useState<Map<string, MediaStream>>(() => new Map());

  const signalingRef = useRef<SignalingClient | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const voiceStopRef = useRef<(() => void) | null>(null);

  const canJoin = wsOpen && Boolean(localPeerId) && roomId.trim().length > 0;
  const canLeave = Boolean(joinedRoomId);

  const sortedParticipants = useMemo(() => {
    const arr = [...participants.values()];
    arr.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return arr;
  }, [participants]);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!mounted) return;
        setMicDevices(devices.filter((d) => d.kind === "audioinput"));
      } catch {
        // ignore
      }
    }
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", onChange);
    return () => {
      mounted = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", onChange);
    };
  }, []);

  useEffect(() => {
    const signaling = new SignalingClient(serverUrl, {
      onOpen: () => setWsOpen(true),
      onClose: () => {
        setWsOpen(false);
        setLocalPeerId(null);
        setJoinedRoomId(null);
        meshRef.current?.closeAll();
        meshRef.current = null;
      },
      onMessage: (msg) => handleServerMessage(msg)
    });
    signaling.connect();
    signalingRef.current = signaling;

    return () => {
      signaling.disconnect();
      signalingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  function handleServerMessage(msg: ServerToClient) {
    if (msg.type === "welcome") {
      setLocalPeerId(msg.peerId);
      return;
    }

    if (msg.type === "peers") {
      setJoinedRoomId(msg.roomId);
      setParticipants((prev) => {
        const next = new Map(prev);
        // ensure local is present
        if (localPeerId) {
          next.set(localPeerId, { peerId: localPeerId, displayName, speaking: localSpeaking });
        }
        for (const p of msg.peers) next.set(p.peerId, { ...p, speaking: false });
        return next;
      });

      ensureMesh(msg.roomId);
      void meshRef.current?.handleSignaling(msg);
      return;
    }

    if (msg.type === "peer-joined") {
      setParticipants((prev) => {
        const next = new Map(prev);
        next.set(msg.peer.peerId, { ...msg.peer, speaking: false });
        return next;
      });
      void meshRef.current?.handleSignaling(msg);
      return;
    }

    if (msg.type === "peer-left") {
      setParticipants((prev) => {
        const next = new Map(prev);
        next.delete(msg.peerId);
        return next;
      });
      setRemoteAudioStreams((prev) => {
        const next = new Map(prev);
        next.delete(msg.peerId);
        return next;
      });
      setRemoteVideoStreams((prev) => {
        const next = new Map(prev);
        next.delete(msg.peerId);
        return next;
      });
      void meshRef.current?.handleSignaling(msg);
      return;
    }

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      void meshRef.current?.handleSignaling(msg);
      return;
    }

    if (msg.type === "text") {
      setChat((prev) => [
        ...prev,
        {
          roomId: msg.roomId,
          channelId: msg.channelId,
          fromName: msg.from.displayName,
          ts: msg.ts,
          message: msg.message
        }
      ]);
      return;
    }

    if (msg.type === "vad") {
      setParticipants((prev) => {
        const next = new Map(prev);
        const p = next.get(msg.from);
        if (p) next.set(msg.from, { ...p, speaking: msg.speaking });
        return next;
      });
      return;
    }
  }

  function ensureMesh(room: string) {
    if (meshRef.current || !localPeerId) return;
    const signaling = signalingRef.current;
    if (!signaling) return;

    const mesh = new PeerMesh({
      signaling,
      roomId: room,
      localPeerId,
      handlers: {
        onRemoteAudioTrack: (peerId, track) => {
          setRemoteAudioStreams((prev) => {
            const next = new Map(prev);
            next.set(peerId, new MediaStream([track]));
            return next;
          });
        },
        onRemoteVideoTrack: (peerId, track) => {
          setRemoteVideoStreams((prev) => {
            const next = new Map(prev);
            next.set(peerId, new MediaStream([track]));
            return next;
          });
        },
        onPeerVad: (peerId, speaking) => {
          setParticipants((prev) => {
            const next = new Map(prev);
            const p = next.get(peerId);
            if (p) next.set(peerId, { ...p, speaking });
            return next;
          });
        }
      }
    });

    meshRef.current = mesh;
  }

  async function join() {
    const signaling = signalingRef.current;
    if (!signaling) return;
    if (!localPeerId) return;

    // reset
    setChat([]);
    setRemoteAudioStreams(new Map());
    setRemoteVideoStreams(new Map());

    setParticipants(() => {
      const m = new Map<string, Participant>();
      m.set(localPeerId, { peerId: localPeerId, displayName, speaking: localSpeaking });
      return m;
    });

    signaling.send({ type: "join", roomId: roomId.trim(), user: { displayName: displayName.trim() } });
  }

  function leave() {
    signalingRef.current?.send({ type: "leave" });
    setJoinedRoomId(null);
    meshRef.current?.closeAll();
    meshRef.current = null;
    setParticipants(new Map());
    setRemoteAudioStreams(new Map());
    setRemoteVideoStreams(new Map());
  }

  async function startVoice() {
    if (!joinedRoomId || !localPeerId) return;
    if (voiceOn) return;

    setLastError(null);
    try {
      const { track, stop } = await startVoicePipeline({
        rnnoiseOn,
        deviceId: micDeviceId,
        onSpeaking: (speaking) => {
          setLocalSpeaking(speaking);
          setParticipants((prev) => {
            const next = new Map(prev);
            const me = next.get(localPeerId);
            if (me) next.set(localPeerId, { ...me, speaking });
            return next;
          });
          // best-effort: via data channel + via server
          meshRef.current?.broadcastVad(speaking);
          signalingRef.current?.send({ type: "vad", roomId: joinedRoomId, speaking });
        }
      });

      voiceStopRef.current = stop;
      setVoiceOn(true);
      meshRef.current?.setLocalAudioTrack(track);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Failed to start microphone");
    }
  }

  function stopVoice() {
    if (!voiceOn) return;
    voiceStopRef.current?.();
    voiceStopRef.current = null;
    setVoiceOn(false);
    meshRef.current?.setLocalAudioTrack(null);
    setLocalSpeaking(false);
  }

  async function startScreenShare() {
    if (!joinedRoomId) return;
    if (screenOn) return;
    setLastError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0] ?? null;
      if (!track) return;
      track.onended = () => stopScreenShare();
      setLocalScreenStream(stream);
      setScreenOn(true);
      meshRef.current?.setLocalScreenTrack(track);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Failed to start screen share");
    }
  }

  function stopScreenShare() {
    setScreenOn(false);
    meshRef.current?.setLocalScreenTrack(null);
    localScreenStream?.getTracks().forEach((t) => t.stop());
    setLocalScreenStream(null);
  }

  function sendMessage() {
    if (!joinedRoomId) return;
    const text = draft.trim();
    if (!text) return;
    signalingRef.current?.send({ type: "text", roomId: joinedRoomId, channelId, message: text });
    setDraft("");
  }

  return (
    <div className="layout">
      <div className="panel">
        <div className="panelHeader">
          <div>
            <div style={{ fontWeight: 700 }}>Ohmcord</div>
            <div className="muted">Electron + WebRTC (≤4)</div>
          </div>
          <span className="pill">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: wsOpen ? "var(--accent)" : "var(--danger)",
                display: "inline-block"
              }}
            />
            {wsOpen ? "connected" : "offline"}
          </span>
        </div>
        <div className="panelBody">
          <div className="stack">
            <div className="stack">
              <div className="muted">Server URL</div>
              <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </div>
            <div className="stack">
              <div className="muted">Display name</div>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div className="stack">
              <div className="muted">Room</div>
              <input className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </div>

            <div className="row">
              <button className="btn btnPrimary" onClick={join} disabled={!canJoin || Boolean(joinedRoomId)}>
                Join
              </button>
              <button className="btn btnDanger" onClick={leave} disabled={!canLeave}>
                Leave
              </button>
            </div>

            {lastError ? (
              <div
                className="msg"
                style={{
                  borderColor: "rgba(251, 113, 133, 0.35)",
                  background: "rgba(251, 113, 133, 0.08)"
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Error</div>
                <div className="muted" style={{ color: "var(--text)" }}>
                  {lastError}
                </div>
              </div>
            ) : null}

            <div className="stack">
              <div className="muted">Voice</div>
              <label className="row">
                <input type="checkbox" checked={rnnoiseOn} onChange={(e) => setRnnoiseOn(e.target.checked)} />
                <span>RNNoise (AudioWorklet)</span>
              </label>
              <div className="stack">
                <div className="muted">Microphone</div>
                <select
                  className="input"
                  value={micDeviceId}
                  onChange={(e) => setMicDeviceId(e.target.value)}
                  disabled={voiceOn}
                >
                  <option value="default">Default</option>
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row">
                <button className="btn btnPrimary" onClick={startVoice} disabled={!joinedRoomId || voiceOn}>
                  Start voice
                </button>
                <button className="btn" onClick={stopVoice} disabled={!voiceOn}>
                  Stop
                </button>
              </div>
            </div>

            <div className="stack">
              <div className="muted">Screen share</div>
              <div className="row">
                <button className="btn btnPrimary" onClick={startScreenShare} disabled={!joinedRoomId || screenOn}>
                  Start share
                </button>
                <button className="btn" onClick={stopScreenShare} disabled={!screenOn}>
                  Stop
                </button>
              </div>
            </div>

            <div className="muted">
              Local peerId: <code>{localPeerId ?? "(waiting)"}</code>
            </div>
            <div className="muted">
              Joined: <code>{joinedRoomId ?? "(not in room)"}</code>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panelHeader">
          <div>
            <div style={{ fontWeight: 700 }}>#{channelId}</div>
            <div className="muted">Text channel</div>
          </div>
          <select className="input" style={{ width: 160 }} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="general">general</option>
            <option value="games">games</option>
            <option value="music">music</option>
          </select>
        </div>
        <div className="chat">
          <div className="chatLog">
            {chat
              .filter((m) => m.channelId === channelId && m.roomId === joinedRoomId)
              .map((m, idx) => (
                <div className="msg" key={`${m.ts}-${idx}`}>
                  <div className="msgMeta">
                    <div className="msgAuthor">{m.fromName}</div>
                    <div className="msgTs">{new Date(m.ts).toLocaleTimeString()}</div>
                  </div>
                  <div className="msgText">{m.message}</div>
                </div>
              ))}
          </div>
          <div className="chatComposer">
            <input
              className="input"
              value={draft}
              placeholder={joinedRoomId ? "Message..." : "Join a room to chat"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
              disabled={!joinedRoomId}
            />
            <button className="btn btnPrimary" onClick={sendMessage} disabled={!joinedRoomId}>
              Send
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panelHeader">
          <div>
            <div style={{ fontWeight: 700 }}>Voice</div>
            <div className="muted">Participants + VAD ring</div>
          </div>
          <span className="pill">
            <VoiceRing speaking={localSpeaking} /> you
          </span>
        </div>
        <div className="panelBody">
          <div className="participants">
            {sortedParticipants.map((p) => (
              <ParticipantRow
                key={p.peerId}
                p={p}
                audioStream={remoteAudioStreams.get(p.peerId) ?? null}
              />
            ))}
          </div>

          <div style={{ height: 12 }} />

          <div className="stack">
            <div className="muted">Screens</div>
            <div className="videoGrid">
              {localScreenStream ? (
                <VideoTile label="You (local)" stream={localScreenStream} />
              ) : (
                <div className="muted">No local share</div>
              )}
              {[...remoteVideoStreams.entries()].map(([peerId, stream]) => (
                <VideoTile key={peerId} label={`Remote: ${participants.get(peerId)?.displayName ?? peerId}`} stream={stream} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ParticipantRow(props: { p: Participant; audioStream: MediaStream | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.srcObject = props.audioStream;
  }, [props.audioStream]);

  return (
    <div className="participant">
      <div className="row" style={{ gap: 10 }}>
        <VoiceRing speaking={props.p.speaking} />
        <div>
          <div style={{ fontWeight: 600 }}>{props.p.displayName}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {props.p.peerId.slice(0, 8)}
          </div>
        </div>
      </div>
      <audio ref={audioRef} autoPlay playsInline />
    </div>
  );
}

function VideoTile(props: { label: string; stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = props.stream;
  }, [props.stream]);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="muted">{props.label}</div>
      <video className="video" ref={ref} autoPlay playsInline muted />
    </div>
  );
}


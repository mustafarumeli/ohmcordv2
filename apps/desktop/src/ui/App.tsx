import React, { useEffect, useMemo, useRef, useState } from "react";
import { SignalingClient } from "../net/signalingClient";
import type { PeerSummary, ServerToClient } from "../shared/protocol";
import { PeerMesh } from "../rtc/peerMesh";
import { VoiceRing } from "./components/VoiceRing";
import { startVoicePipeline } from "../audio/voicePipeline";
import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Timestamp
} from "firebase/firestore";
import { displayNameFromUid, ensureAnonUser, getFirebaseDb } from "./firebase";

type ChatMessage = {
  roomId: string;
  channelId: string;
  uid: string;
  fromName: string;
  ts: number;
  message: string;
};

type Participant = PeerSummary & {
  speaking: boolean;
  connState?: RTCPeerConnectionState;
  iceState?: RTCIceConnectionState;
};

type PeerConnSummary = {
  connState: RTCPeerConnectionState;
  iceState: RTCIceConnectionState;
};

const DEFAULT_CHANNEL_ID = "general";
const SIGNALING_URL = (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? "ws://localhost:8787";

type RoomSummary = {
  id: string;
  name: string;
  createdAtMs: number;
};

type SignalKind = "offer" | "answer" | "ice";
type SignalCounter = Record<SignalKind, number>;
type SignalingCounters = {
  sent: SignalCounter;
  recv: SignalCounter;
};

const EMPTY_SIGNAL_COUNTER: SignalCounter = { offer: 0, answer: 0, ice: 0 };

function friendlyFirebaseError(e: unknown): string {
  const code =
    e && typeof e === "object" && "code" in e && typeof (e as { code?: unknown }).code === "string"
      ? ((e as { code: string }).code as string)
      : null;

  if (code === "auth/configuration-not-found") {
    return [
      "Firebase Auth is not configured for this project.",
      "Enable Authentication in Firebase Console and turn on the Anonymous provider.",
      "Also verify you copied the Web App config (apiKey/authDomain/projectId/appId) from the same project."
    ].join(" ");
  }
  if (code === "auth/invalid-api-key" || code === "auth/api-key-not-valid") {
    return "Firebase apiKey is invalid. Re-copy the Web App config from Firebase Console (Project settings -> General -> Your apps).";
  }
  if (code === "permission-denied") {
    return "Firestore permission denied. Check your Firestore security rules (and that Anonymous Auth is enabled).";
  }

  if (e instanceof Error) return e.message;
  return "Unexpected error";
}

export function App() {
  const [uid, setUid] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("...");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [createRoomName, setCreateRoomName] = useState("");

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
  const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakerDeviceId, setSpeakerDeviceId] = useState<string>("default");
  const [lastError, setLastError] = useState<string | null>(null);

  const [screenOn, setScreenOn] = useState(false);
  const [loopbackOn, setLoopbackOn] = useState(false);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Map<string, MediaStream>>(() => new Map());
  const [remoteAudioStreams, setRemoteAudioStreams] = useState<Map<string, MediaStream>>(() => new Map());
  const [peerConnStates, setPeerConnStates] = useState<Map<string, PeerConnSummary>>(() => new Map());
  const [signalingCounters, setSignalingCounters] = useState<SignalingCounters>({
    sent: { ...EMPTY_SIGNAL_COUNTER },
    recv: { ...EMPTY_SIGNAL_COUNTER }
  });

  const signalingRef = useRef<SignalingClient | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const voiceStopRef = useRef<(() => void) | null>(null);
  const loopbackStopRef = useRef<(() => void) | null>(null);
  const loopbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const localPeerIdRef = useRef<string | null>(null);
  const displayNameRef = useRef<string>(displayName);
  const localSpeakingRef = useRef<boolean>(localSpeaking);

  const canJoin = wsOpen && Boolean(localPeerId) && Boolean(uid) && Boolean(selectedRoomId);
  const canLeave = Boolean(joinedRoomId);
  const selectedRoomName = useMemo(() => {
    const id = joinedRoomId ?? selectedRoomId;
    if (!id) return null;
    return rooms.find((r) => r.id === id)?.name ?? id;
  }, [joinedRoomId, rooms, selectedRoomId]);

  const sortedParticipants = useMemo(() => {
    const arr = [...participants.values()];
    arr.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return arr;
  }, [participants]);

  const sortedParticipantsWithConn = useMemo(() => {
    return sortedParticipants.map((p) => {
      const s = peerConnStates.get(p.peerId);
      return s ? { ...p, connState: s.connState, iceState: s.iceState } : p;
    });
  }, [peerConnStates, sortedParticipants]);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!mounted) return;
        setMicDevices(devices.filter((d) => d.kind === "audioinput"));
        setSpeakerDevices(devices.filter((d) => d.kind === "audiooutput"));
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
    const signaling = new SignalingClient(SIGNALING_URL, {
      onOpen: () => setWsOpen(true),
      onClose: () => {
        setWsOpen(false);
        setLocalPeerId(null);
        setJoinedRoomId(null);
        meshRef.current?.closeAll();
        meshRef.current = null;
      },
      onSend: (msg) => {
        if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
          bumpSignalCounter("sent", msg.type);
        }
      },
      onMessage: (msg) => handleServerMessage(msg)
    });
    signaling.connect();
    signalingRef.current = signaling;

    return () => {
      signaling.disconnect();
      signalingRef.current = null;
      loopbackStopRef.current?.();
      loopbackStopRef.current = null;
    };
  }, []);

  function bumpSignalCounter(direction: "sent" | "recv", kind: SignalKind) {
    setSignalingCounters((prev) => {
      const next: SignalingCounters = {
        ...prev,
        [direction]: {
          ...prev[direction],
          [kind]: prev[direction][kind] + 1
        }
      };
      // eslint-disable-next-line no-console
      console.debug(`[signaling ${direction}] ${kind}`, next[direction]);
      return next;
    });
  }

  useEffect(() => {
    localPeerIdRef.current = localPeerId;
  }, [localPeerId]);

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  useEffect(() => {
    localSpeakingRef.current = localSpeaking;
  }, [localSpeaking]);

  useEffect(() => {
    let cancelled = false;
    async function initAuth() {
      try {
        const user = await ensureAnonUser();
        if (cancelled) return;
        setUid(user.uid);
        setDisplayName(displayNameFromUid(user.uid));
      } catch (e) {
        if (cancelled) return;
        setLastError(friendlyFirebaseError(e));
      }
    }
    void initAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const db = getFirebaseDb();
      const q = query(collection(db, "rooms"), orderBy("createdAt", "desc"), limit(200));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const next: RoomSummary[] = snap.docs.map((d) => {
            const data = d.data() as { name?: string; createdAt?: Timestamp };
            return {
              id: d.id,
              name: data.name ?? d.id,
              createdAtMs: data.createdAt ? data.createdAt.toMillis() : 0
            };
          });
          setRooms(next);
          setSelectedRoomId((prev) => {
            if (prev && next.some((r) => r.id === prev)) return prev;
            return next[0]?.id ?? null;
          });
        },
        (err) => setLastError(friendlyFirebaseError(err))
      );
      return () => unsub();
    } catch (e) {
      setLastError(friendlyFirebaseError(e));
      return;
    }
  }, []);

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
        const myPeerId = localPeerIdRef.current;
        if (myPeerId) {
          next.set(myPeerId, {
            peerId: myPeerId,
            displayName: displayNameRef.current,
            speaking: localSpeakingRef.current,
            connState: "connected",
            iceState: "connected"
          });
        }
        for (const p of msg.peers) next.set(p.peerId, { ...p, speaking: false, connState: "new", iceState: "new" });
        return next;
      });

      ensureMesh(msg.roomId);
      void meshRef.current?.handleSignaling(msg);
      return;
    }

    if (msg.type === "peer-joined") {
      setParticipants((prev) => {
        const next = new Map(prev);
        next.set(msg.peer.peerId, { ...msg.peer, speaking: false, connState: "new", iceState: "new" });
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
      setPeerConnStates((prev) => {
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
      bumpSignalCounter("recv", msg.type);
      void meshRef.current?.handleSignaling(msg);
      return;
    }

    if (msg.type === "text") {
      // Text chat source of truth is Firestore (history). Ignore WS text messages.
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
    const myPeerId = localPeerIdRef.current;
    if (meshRef.current || !myPeerId) return;
    const signaling = signalingRef.current;
    if (!signaling) return;

    const mesh = new PeerMesh({
      signaling,
      roomId: room,
      localPeerId: myPeerId,
      handlers: {
        onPeerConnState: (peerId, state, ice) => {
          setPeerConnStates((prev) => {
            const next = new Map(prev);
            next.set(peerId, { connState: state, iceState: ice });
            return next;
          });
        },
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
    const myPeerId = localPeerIdRef.current;
    if (!myPeerId) return;
    if (!uid) return;
    if (!selectedRoomId) return;

    // reset
    setChat([]);
    setRemoteAudioStreams(new Map());
    setRemoteVideoStreams(new Map());
    setPeerConnStates(new Map());
    setSignalingCounters({
      sent: { ...EMPTY_SIGNAL_COUNTER },
      recv: { ...EMPTY_SIGNAL_COUNTER }
    });

    setParticipants(() => {
      const m = new Map<string, Participant>();
      m.set(myPeerId, { peerId: myPeerId, displayName, speaking: localSpeakingRef.current });
      return m;
    });

    signaling.send({ type: "join", roomId: selectedRoomId, user: { displayName } });
    void unlockAudioPlayback();
  }

  function leave() {
    signalingRef.current?.send({ type: "leave" });
    setJoinedRoomId(null);
    meshRef.current?.closeAll();
    meshRef.current = null;
    stopLoopbackTest();
    setParticipants(new Map());
    setRemoteAudioStreams(new Map());
    setRemoteVideoStreams(new Map());
    setPeerConnStates(new Map());
  }

  async function startVoice() {
    if (!joinedRoomId || !localPeerId) return;
    if (voiceOn) return;

    setLastError(null);
    try {
      void unlockAudioPlayback();
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

  async function startLoopbackTest() {
    if (loopbackOn) return;
    setLastError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(micDeviceId && micDeviceId !== "default" ? { deviceId: { exact: micDeviceId } } : {})
        },
        video: false
      });
      const audioEl = loopbackAudioRef.current;
      if (!audioEl) throw new Error("Loopback audio element not ready");
      const sinkAudio = audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (speakerDeviceId !== "default" && typeof sinkAudio.setSinkId === "function") {
        await sinkAudio.setSinkId(speakerDeviceId);
      }
      audioEl.srcObject = stream;
      audioEl.muted = false;
      audioEl.volume = 1;
      await audioEl.play();
      loopbackStopRef.current = () => {
        stream.getTracks().forEach((t) => t.stop());
        audioEl.srcObject = null;
      };
      setLoopbackOn(true);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Failed to start loopback test");
    }
  }

  function stopLoopbackTest() {
    loopbackStopRef.current?.();
    loopbackStopRef.current = null;
    setLoopbackOn(false);
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

  async function sendMessage() {
    if (!joinedRoomId) return;
    if (!uid) return;
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      const db = getFirebaseDb();
      await addDoc(collection(db, "rooms", joinedRoomId, "channels", channelId, "messages"), {
        uid,
        fromName: displayName,
        message: text,
        ts: serverTimestamp()
      });
    } catch (e) {
      setLastError(friendlyFirebaseError(e));
    }
  }

  async function unlockAudioPlayback() {
    try {
      const list = Array.from(document.querySelectorAll("audio"));
      await Promise.all(
        list.map(async (el) => {
          try {
            const sinkAudio = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
            if (speakerDeviceId !== "default" && typeof sinkAudio.setSinkId === "function") {
              await sinkAudio.setSinkId(speakerDeviceId);
            }
            el.muted = false;
            el.volume = 1;
            await el.play();
          } catch {
            // ignore; per-element errors are surfaced in ParticipantRow too
          }
        })
      );
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    async function applySpeaker() {
      const list = Array.from(document.querySelectorAll("audio"));
      await Promise.all(
        list.map(async (el) => {
          const sinkAudio = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          if (speakerDeviceId !== "default" && typeof sinkAudio.setSinkId === "function") {
            try {
              await sinkAudio.setSinkId(speakerDeviceId);
            } catch (e) {
              setLastError(e instanceof Error ? e.message : "Failed to switch speaker output");
            }
          }
        })
      );
    }
    void applySpeaker();
  }, [speakerDeviceId]);

  useEffect(() => {
    if (!joinedRoomId) {
      setChat([]);
      return;
    }
    try {
      const db = getFirebaseDb();
      const q = query(
        collection(db, "rooms", joinedRoomId, "channels", channelId, "messages"),
        orderBy("ts", "asc"),
        limit(200)
      );
      const unsub = onSnapshot(
        q,
        (snap) => {
          const msgs: ChatMessage[] = snap.docs.map((d) => {
            const data = d.data() as { uid?: string; fromName?: string; message?: string; ts?: Timestamp };
            return {
              roomId: joinedRoomId,
              channelId,
              uid: data.uid ?? "unknown",
              fromName: data.fromName ?? "Unknown",
              message: data.message ?? "",
              ts: data.ts ? data.ts.toMillis() : 0
            };
          });
          setChat(msgs);
        },
      (err) => setLastError(friendlyFirebaseError(err))
      );
      return () => unsub();
    } catch (e) {
      setLastError(friendlyFirebaseError(e));
      return;
    }
  }, [joinedRoomId, channelId]);

  async function createRoom() {
    if (!uid) return;
    const name = createRoomName.trim();
    if (!name) return;
    setCreateRoomName("");
    setCreateRoomOpen(false);
    try {
      const db = getFirebaseDb();
      const docRef = await addDoc(collection(db, "rooms"), {
        name,
        createdAt: serverTimestamp(),
        createdBy: uid,
        lastActiveAt: serverTimestamp()
      });
      setSelectedRoomId(docRef.id);
    } catch (e) {
      setLastError(friendlyFirebaseError(e));
    }
  }

  return (
    <div className="layout">
      <div className="panel sidebar">
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
          <div className="stack" style={{ gap: 12 }}>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="muted">Rooms</div>
                <button className="btn btnPrimary btnIcon" onClick={() => setCreateRoomOpen((v) => !v)} disabled={!uid}>
                  +
                </button>
              </div>
              {createRoomOpen ? (
                <div className="row">
                  <input
                    className="input"
                    value={createRoomName}
                    placeholder="New room name"
                    onChange={(e) => setCreateRoomName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createRoom();
                      if (e.key === "Escape") setCreateRoomOpen(false);
                    }}
                  />
                  <button className="btn btnPrimary" onClick={() => void createRoom()} disabled={!createRoomName.trim()}>
                    Create
                  </button>
                </div>
              ) : null}
              <div className="roomList">
                {rooms.length === 0 ? <div className="muted">No rooms yet</div> : null}
                {rooms.map((r) => (
                  <button
                    key={r.id}
                    className={`roomItem ${selectedRoomId === r.id ? "roomItemActive" : ""}`}
                    onClick={() => setSelectedRoomId(r.id)}
                    title={r.id}
                  >
                    <div className="roomName">{r.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.id.slice(0, 8)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="row">
              <button className="btn btnPrimary" onClick={() => void join()} disabled={!canJoin || Boolean(joinedRoomId)}>
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
              <div className="stack">
                <div className="muted">Speaker</div>
                <select className="input" value={speakerDeviceId} onChange={(e) => setSpeakerDeviceId(e.target.value)}>
                  <option value="default">Default</option>
                  {speakerDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Speaker ${d.deviceId.slice(0, 8)}`}
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
              <div className="row">
                <button className="btn" onClick={() => void startLoopbackTest()} disabled={loopbackOn}>
                  Loopback test
                </button>
                <button className="btn" onClick={stopLoopbackTest} disabled={!loopbackOn}>
                  Stop test
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
            <div className="muted">
              You: <code>{displayName}</code>
            </div>
            <audio ref={loopbackAudioRef} autoPlay playsInline />
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panelHeader">
          <div>
            <div style={{ fontWeight: 700 }}>#{channelId}</div>
            <div className="muted">{selectedRoomName ? selectedRoomName : "Select a room"}</div>
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
                if (e.key === "Enter") void sendMessage();
              }}
              disabled={!joinedRoomId}
            />
            <button className="btn btnPrimary" onClick={() => void sendMessage()} disabled={!joinedRoomId}>
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
            <div className="signalBadge muted">
              tx o/a/i: {signalingCounters.sent.offer}/{signalingCounters.sent.answer}/{signalingCounters.sent.ice} | rx o/a/i:{" "}
              {signalingCounters.recv.offer}/{signalingCounters.recv.answer}/{signalingCounters.recv.ice}
            </div>
          </div>
          <span className="pill">
            <VoiceRing speaking={localSpeaking} /> you
          </span>
        </div>
        <div className="panelBody">
          <div className="participants">
            {sortedParticipantsWithConn.map((p) => (
              <ParticipantRow
                key={p.peerId}
                p={p}
                audioStream={remoteAudioStreams.get(p.peerId) ?? null}
                speakerDeviceId={speakerDeviceId}
                onPlaybackBlocked={() =>
                  setLastError(
                    "Remote audio stream arrived but playback was blocked by the browser. Click Join/Start voice again to unlock audio output."
                  )
                }
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

function ParticipantRow(props: {
  p: Participant;
  audioStream: MediaStream | null;
  speakerDeviceId: string;
  onPlaybackBlocked?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.srcObject = props.audioStream;
    const sinkAudio = audioRef.current as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    audioRef.current.muted = false;
    audioRef.current.volume = 1;
    if (props.speakerDeviceId !== "default" && typeof sinkAudio.setSinkId === "function") {
      void sinkAudio.setSinkId(props.speakerDeviceId).catch(() => props.onPlaybackBlocked?.());
    }
    if (props.audioStream) {
      // Chromium may block autoplay; best-effort start.
      void audioRef.current.play().catch(() => props.onPlaybackBlocked?.());
    }
  }, [props.audioStream, props.onPlaybackBlocked, props.speakerDeviceId]);

  return (
    <div className="participant">
      <div className="row" style={{ gap: 10 }}>
        <VoiceRing speaking={props.p.speaking} />
        <div>
          <div style={{ fontWeight: 600 }}>{props.p.displayName}</div>
          <div className="row" style={{ gap: 8, marginTop: 2 }}>
            <div className="muted" style={{ fontSize: 11 }}>
              {props.p.peerId.slice(0, 8)}
            </div>
            {props.p.connState ? <span className="connTag">pc:{props.p.connState}</span> : null}
            {props.p.iceState ? <span className="connTag">ice:{props.p.iceState}</span> : null}
            {props.audioStream ? <span className="connTag">audio</span> : null}
          </div>
        </div>
      </div>
      <audio
        ref={audioRef}
        autoPlay
        playsInline
        onCanPlay={() => {
          if (!audioRef.current) return;
          void audioRef.current.play().catch(() => props.onPlaybackBlocked?.());
        }}
      />
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


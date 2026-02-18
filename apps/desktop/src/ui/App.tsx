import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type Timestamp
} from "firebase/firestore";
import { startVoicePipeline } from "../audio/voicePipeline";
import { SignalingClient } from "../net/signalingClient";
import { PeerMesh } from "../rtc/peerMesh";
import type { PeerSummary, ServerToClient } from "../shared/protocol";
import { ensureAnonUser, getFirebaseDb, displayNameFromUid } from "./firebase";
import { ChannelList, type ChannelSummary } from "./components/ChannelList";
import { ChatPanel } from "./components/ChatPanel";
import { Onboarding } from "./components/Onboarding";
import { VoicePanel, type Participant } from "./components/VoicePanel";
import { RemoteAudioRack } from "./components/RemoteAudioRack";
import { BottomBar } from "./components/BottomBar";

type PeerConnSummary = {
  connState: RTCPeerConnectionState;
  iceState: RTCIceConnectionState;
};

type SignalKind = "offer" | "answer" | "ice";
type SignalCounter = Record<SignalKind, number>;
type SignalingCounters = {
  sent: SignalCounter;
  recv: SignalCounter;
};

const EMPTY_SIGNAL_COUNTER: SignalCounter = { offer: 0, answer: 0, ice: 0 };

const SIGNALING_URL = (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? "ws://localhost:8080";

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
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<"text" | "voice">("text");
  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId) ?? null, [channels, selectedChannelId]);

  const [wsOpen, setWsOpen] = useState(false);
  const [localPeerId, setLocalPeerId] = useState<string | null>(null);
  const [joinedVoiceKey, setJoinedVoiceKey] = useState<string | null>(null);

  const [participants, setParticipants] = useState<Map<string, Participant>>(() => new Map());

  const [voiceOn, setVoiceOn] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [rnnoiseOn, setRnnoiseOn] = useState(true);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>("default");
  const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakerDeviceId, setSpeakerDeviceId] = useState<string>("default");
  const [inputVolume, setInputVolume] = useState(1);
  const [outputVolume, setOutputVolume] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareAudioMuted, setShareAudioMuted] = useState(true);
  const [shareAudioVolume, setShareAudioVolume] = useState(1);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createChannelName, setCreateChannelName] = useState("");
  const [createChannelType, setCreateChannelType] = useState<"text" | "voice">("text");
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
  const voiceStartingRef = useRef(false);
  const loopbackStopRef = useRef<(() => void) | null>(null);
  const loopbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const localPeerIdRef = useRef<string | null>(null);
  const joinedVoiceKeyRef = useRef<string | null>(null);
  const displayNameRef = useRef<string>(displayName);
  const localSpeakingRef = useRef<boolean>(localSpeaking);
  const localAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const setInputGainRef = useRef<((v: number) => void) | null>(null);

  const sortedParticipantsWithConn = useMemo(() => {
    const arr = [...participants.values()];
    arr.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return arr.map((p) => {
      const s = peerConnStates.get(p.peerId);
      return s ? { ...p, connState: s.connState, iceState: s.iceState } : p;
    });
  }, [participants, peerConnStates]);

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
        disconnectVoice();
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
    joinedVoiceKeyRef.current = joinedVoiceKey;
  }, [joinedVoiceKey]);

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
        const stored = window.localStorage.getItem("ohmcord.displayName");
        if (stored && stored.trim()) {
          setDisplayName(stored.trim());
          setNeedsOnboarding(false);
        } else {
          setDisplayName(displayNameFromUid(user.uid));
          setNeedsOnboarding(true);
        }
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

  // Settings from localStorage
  useEffect(() => {
    const vIn = Number(window.localStorage.getItem("ohmcord.settings.inputVolume") ?? "1");
    const vOut = Number(window.localStorage.getItem("ohmcord.settings.outputVolume") ?? "1");
    const rn = window.localStorage.getItem("ohmcord.settings.rnnoiseOn");
    if (Number.isFinite(vIn)) setInputVolume(Math.max(0, Math.min(2, vIn)));
    if (Number.isFinite(vOut)) setOutputVolume(Math.max(0, Math.min(1, vOut)));
    if (rn === "0") setRnnoiseOn(false);
  }, []);

  // Root channels list
  useEffect(() => {
    setChannels([]);
    setSelectedChannelId(null);
    setActivePanel("text");

    try {
      const db = getFirebaseDb();
      const q = query(collection(db, "channels"), orderBy("createdAt", "desc"), limit(500));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const next: ChannelSummary[] = snap.docs.map((d) => {
            const data = d.data() as { name?: string; type?: unknown };
            const t = data.type === "voice" ? "voice" : "text";
            return { id: d.id, name: data.name ?? d.id, type: t };
          });
          setChannels(next);
        },
        (err) => setLastError(friendlyFirebaseError(err))
      );
      return () => unsub();
    } catch (e) {
      setLastError(friendlyFirebaseError(e));
      return;
    }
  }, []);

  // Ensure defaults exist (best effort)
  const ensuredDefaultsRef = useRef(false);
  useEffect(() => {
    async function ensureDefaults() {
      if (!uid) return;
      if (ensuredDefaultsRef.current) return;
      ensuredDefaultsRef.current = true;
      try {
        const db = getFirebaseDb();
        const colRef = collection(db, "channels");
        const existing = await getDocs(query(colRef, limit(1)));
        if (!existing.empty) return;
        await Promise.all([
          setDoc(doc(colRef, "sema-sozleri"), { name: "sema-sozleri", type: "text", createdAt: serverTimestamp(), createdBy: uid }),
          setDoc(doc(colRef, "voice"), { name: "voice", type: "voice", createdAt: serverTimestamp(), createdBy: uid })
        ]);
      } catch {
        // ignore
      }
    }
    void ensureDefaults();
  }, [uid]);

  // Default selection
  useEffect(() => {
    if (channels.length === 0) return;
    setSelectedChannelId((prev) => {
      if (prev && channels.some((c) => c.id === prev)) return prev;
      const firstText = channels.find((c) => c.type === "text")?.id ?? channels[0]?.id ?? null;
      return firstText;
    });
  }, [channels]);

  function handleServerMessage(msg: ServerToClient) {
    if (msg.type === "welcome") {
      setLocalPeerId(msg.peerId);
      return;
    }

    if (msg.type === "peers") {
      setJoinedVoiceKey(msg.roomId);
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
    if (!myPeerId) return;
    const signaling = signalingRef.current;
    if (!signaling) return;

    const existing = meshRef.current as (PeerMesh & { __roomId?: string }) | null;
    if (existing && existing.__roomId === room) return;
    if (existing && existing.__roomId !== room) {
      existing.closeAll();
      meshRef.current = null;
    }

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
        onRemoteAudioTrack: (peerId, track, stream) => {
          // If an audio track belongs to a stream that also has video, treat it as screen-share media.
          if (stream.getVideoTracks().length > 0) {
            setRemoteVideoStreams((prev) => {
              const next = new Map(prev);
              next.set(peerId, stream);
              return next;
            });
            return;
          }
          setRemoteAudioStreams((prev) => {
            const next = new Map(prev);
            next.set(peerId, new MediaStream([track]));
            return next;
          });
        },
        onRemoteVideoTrack: (peerId, track, stream) => {
          const clearPeerVideoIfCurrentTrack = () => {
            setRemoteVideoStreams((prev) => {
              const currentTrack = prev.get(peerId)?.getVideoTracks()[0];
              if (!currentTrack || currentTrack.id !== track.id) return prev;
              const next = new Map(prev);
              next.delete(peerId);
              return next;
            });
          };

          track.onended = clearPeerVideoIfCurrentTrack;

          setRemoteVideoStreams((prev) => {
            const next = new Map(prev);
            next.set(peerId, stream);
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

    (mesh as any).__roomId = room;
    meshRef.current = mesh;
    if (localAudioTrackRef.current) mesh.setLocalAudioTrack(localAudioTrackRef.current);
    if (screenOn && localScreenStream) {
      mesh.setLocalScreenMedia(localScreenStream);
    }
  }

  function joinVoiceChannel(channelId: string) {
    const signaling = signalingRef.current;
    if (!signaling) return;
    const myPeerId = localPeerIdRef.current;
    if (!myPeerId) return;

    const key = channelId;
    if (joinedVoiceKeyRef.current === key) return;

    // switch: leave old voice room first
    if (joinedVoiceKeyRef.current) signaling.send({ type: "leave" });
    cleanupVoiceState();

    setSignalingCounters({
      sent: { ...EMPTY_SIGNAL_COUNTER },
      recv: { ...EMPTY_SIGNAL_COUNTER }
    });
    // Mark joined locally right away so voice controls are enabled
    // while waiting for server "peers" payload.
    setJoinedVoiceKey(key);
    joinedVoiceKeyRef.current = key;
    setParticipants(() => {
      const m = new Map<string, Participant>();
      m.set(myPeerId, { peerId: myPeerId, displayName: displayNameRef.current, speaking: localSpeakingRef.current });
      return m;
    });

    ensureMesh(key);
    signaling.send({ type: "join", roomId: key, user: { displayName: displayNameRef.current } });
    void unlockAudioPlayback();
  }

  function cleanupVoiceState() {
    setJoinedVoiceKey(null);
    meshRef.current?.closeAll();
    meshRef.current = null;
    stopLoopbackTest();
    setParticipants(new Map());
    setRemoteAudioStreams(new Map());
    setRemoteVideoStreams(new Map());
    setPeerConnStates(new Map());
  }

  function disconnectVoice() {
    signalingRef.current?.send({ type: "leave" });
    stopVoice();
    cleanupVoiceState();
  }

  async function startVoice() {
    if (!joinedVoiceKey || !localPeerId) return;
    // Don't rely on React state here (it can be stale within the same tick after stopVoice()).
    if (voiceStopRef.current) return;
    if (voiceStartingRef.current) return;

    setLastError(null);
    voiceStartingRef.current = true;
    try {
      void unlockAudioPlayback();
      const { track, stop, setInputGain } = await startVoicePipeline({
        rnnoiseOn,
        deviceId: micDeviceId,
        inputGain: inputVolume,
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
          const key = joinedVoiceKeyRef.current;
          if (key) signalingRef.current?.send({ type: "vad", roomId: key, speaking });
        }
      });

      voiceStopRef.current = stop;
      setInputGainRef.current = setInputGain;
      setVoiceOn(true);
      localAudioTrackRef.current = track;
      meshRef.current?.setLocalAudioTrack(track);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Failed to start microphone");
    } finally {
      voiceStartingRef.current = false;
    }
  }

  function stopVoice() {
    if (!voiceStopRef.current) return;
    voiceStopRef.current?.();
    voiceStopRef.current = null;
    setInputGainRef.current = null;
    setVoiceOn(false);
    localAudioTrackRef.current = null;
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
    if (!joinedVoiceKey) return;
    if (screenOn) return;
    setLastError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const track = stream.getVideoTracks()[0] ?? null;
      if (!track) return;
      track.onended = () => stopScreenShare();
      setLocalScreenStream(stream);
      setScreenOn(true);
      meshRef.current?.setLocalScreenMedia(stream);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Failed to start screen share");
    }
  }

  function stopScreenShare() {
    setScreenOn(false);
    meshRef.current?.setLocalScreenMedia(null);
    localScreenStream?.getTracks().forEach((t) => t.stop());
    setLocalScreenStream(null);
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
            el.muted = deafened;
            el.volume = outputVolume;
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
          el.muted = deafened;
          el.volume = outputVolume;
        })
      );
    }
    void applySpeaker();
  }, [speakerDeviceId, outputVolume, deafened]);

  // Auto-start mic when joining a voice room.
  useEffect(() => {
    if (!joinedVoiceKey) return;
    if (voiceOn) return;
    void startVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedVoiceKey]);

  useEffect(() => {
    // chat history is handled by ChatPanel (Firestore + pagination)
  }, []);

  useEffect(() => {
    window.localStorage.setItem("ohmcord.settings.inputVolume", String(inputVolume));
    if (voiceOn) setInputGainRef.current?.(inputVolume);
  }, [inputVolume, voiceOn]);
  useEffect(() => {
    window.localStorage.setItem("ohmcord.settings.outputVolume", String(outputVolume));
  }, [outputVolume]);
  useEffect(() => {
    window.localStorage.setItem("ohmcord.settings.rnnoiseOn", rnnoiseOn ? "1" : "0");
    if (voiceOn) {
      // apply on next start by restarting; keep simple and predictable
      stopVoice();
      void startVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rnnoiseOn]);

  useEffect(() => {
    if (!voiceOn) return;
    if (!joinedVoiceKey) return;
    // Switching input device requires restarting the pipeline.
    stopVoice();
    void startVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micDeviceId]);

  function slugify(name: string): string {
    const map: Record<string, string> = { "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u" };
    const lowered = name
      .trim()
      .toLowerCase()
      .split("")
      .map((ch) => map[ch] ?? ch)
      .join("");
    const slug = lowered
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return slug || "channel";
  }

  async function createChannel() {
    if (!uid) return;
    const name = createChannelName.trim();
    if (!name) return;
    setCreateChannelOpen(false);
    setCreateChannelName("");
    try {
      const db = getFirebaseDb();
      const base = slugify(name);
      let id = base;
      for (let i = 0; i < 20; i++) {
        const ref = doc(db, "channels", id);
        const exists = await getDoc(ref);
        if (!exists.exists()) break;
        id = `${base}-${i + 2}`;
      }
      await setDoc(doc(db, "channels", id), {
        name,
        type: createChannelType,
        createdAt: serverTimestamp(),
        createdBy: uid
      });
      setSelectedChannelId(id);
      setActivePanel(createChannelType === "voice" ? "voice" : "text");
      if (createChannelType === "voice") joinVoiceChannel(id);
    } catch (e) {
      setLastError(friendlyFirebaseError(e));
    }
  }

  const canUseVoiceActions = Boolean(joinedVoiceKey);

  return (
    <div className="layout">
      {needsOnboarding ? (
        <Onboarding
          initialName={displayName}
          onSubmit={(name) => {
            window.localStorage.setItem("ohmcord.displayName", name);
            setDisplayName(name);
            setNeedsOnboarding(false);
          }}
        />
      ) : null}

      <div className="panel sidebar">
        <div className="panelHeader">
          <div>
            <div style={{ fontWeight: 700 }}>Ohmcord</div>
            <div className="muted">Channels</div>
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
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="muted">Channels</div>
              <button className="btn btnPrimary btnIcon" onClick={() => setCreateChannelOpen((v) => !v)} disabled={!uid}>
                +
              </button>
            </div>

            {createChannelOpen ? (
              <div className="stack">
                <input
                  className="input"
                  value={createChannelName}
                  placeholder="New channel name"
                  onChange={(e) => setCreateChannelName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createChannel();
                    if (e.key === "Escape") setCreateChannelOpen(false);
                  }}
                />
                <div className="row">
                  <select className="input" value={createChannelType} onChange={(e) => setCreateChannelType(e.target.value as "text" | "voice")}>
                    <option value="text">text</option>
                    <option value="voice">voice</option>
                  </select>
                  <button className="btn btnPrimary" onClick={() => void createChannel()} disabled={!createChannelName.trim()}>
                    Create
                  </button>
                </div>
              </div>
            ) : null}

            <div className="panel" style={{ background: "transparent", border: "none" }}>
              <ChannelList
                channels={channels}
                selectedChannelId={selectedChannelId}
                disabled={!uid}
                joinedVoiceKey={joinedVoiceKey}
                participants={sortedParticipantsWithConn.map((p) => ({ peerId: p.peerId, displayName: p.displayName, speaking: p.speaking }))}
                onSelect={(id) => {
                  setSelectedChannelId(id);
                  const c = channels.find((x) => x.id === id);
                  const t = c?.type ?? "text";
                  setActivePanel(t === "voice" ? "voice" : "text");
                  if (t === "voice") joinVoiceChannel(id);
                }}
              />
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

            <div className="muted">
              You: <code>{displayName}</code>
            </div>
          </div>
        </div>
      </div>

      {activePanel === "voice" ? (
        <VoicePanel
          voiceChannelId={selectedChannel?.type === "voice" ? selectedChannel.name : null}
          wsOpen={wsOpen}
          joinedVoiceKey={joinedVoiceKey}
          localPeerId={localPeerId}
          localSpeaking={localSpeaking}
          participants={sortedParticipantsWithConn}
          signalingCounters={signalingCounters}
          speakerDeviceId={speakerDeviceId}
          outputVolume={outputVolume}
          onStartScreenShare={() => void startScreenShare()}
          onStopScreenShare={stopScreenShare}
          screenOn={screenOn}
          localScreenStream={localScreenStream}
          remoteVideoStreams={remoteVideoStreams}
          shareAudioMuted={shareAudioMuted}
          shareAudioVolume={shareAudioVolume}
          onToggleShareAudio={() => setShareAudioMuted((v) => !v)}
          onShareAudioVolumeChange={setShareAudioVolume}
          onPlaybackBlocked={() =>
            setLastError(
              "Remote audio stream arrived but playback was blocked by the browser. Click the voice channel again or Start voice to unlock audio output."
            )
          }
        />
      ) : (
        <ChatPanel
          channelId={selectedChannel?.type === "text" ? selectedChannelId : null}
          uid={uid}
          displayName={displayName}
          disabled={needsOnboarding}
          onError={(msg) => setLastError(msg)}
        />
      )}

      <RemoteAudioRack
        streams={remoteAudioStreams}
        speakerDeviceId={speakerDeviceId}
        volume={outputVolume}
        deafened={deafened}
        onPlaybackBlocked={() =>
          setLastError(
            "Remote audio stream arrived but playback was blocked by the browser. Click the voice channel again or Start voice to unlock audio output."
          )
        }
      />

      <BottomBar
        displayName={displayName}
        joinedVoiceKey={joinedVoiceKey}
        voiceOn={voiceOn}
        deafened={deafened}
        canUseVoiceActions={canUseVoiceActions}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        onCloseSettings={() => setSettingsOpen(false)}
        onToggleMic={() => (voiceOn ? stopVoice() : void startVoice())}
        onToggleDeafen={() => setDeafened((v) => !v)}
        onDisconnectVoice={disconnectVoice}
        rnnoiseOn={rnnoiseOn}
        setRnnoiseOn={setRnnoiseOn}
        micDevices={micDevices}
        micDeviceId={micDeviceId}
        setMicDeviceId={setMicDeviceId}
        speakerDevices={speakerDevices}
        speakerDeviceId={speakerDeviceId}
        setSpeakerDeviceId={setSpeakerDeviceId}
        inputVolume={inputVolume}
        setInputVolume={setInputVolume}
        outputVolume={outputVolume}
        setOutputVolume={setOutputVolume}
      />
    </div>
  );
}

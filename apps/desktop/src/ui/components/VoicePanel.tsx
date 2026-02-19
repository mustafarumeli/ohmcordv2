import React, { useEffect, useMemo, useRef, useState } from "react";
import { VoiceRing } from "./VoiceRing";

export type Participant = {
  peerId: string;
  displayName: string;
  speaking: boolean;
  micOn: boolean;
  deafened: boolean;
  connState?: RTCPeerConnectionState;
  iceState?: RTCIceConnectionState;
};

export function VoicePanel(props: {
  voiceChannelId: string | null;
  wsOpen: boolean;
  joinedVoiceKey: string | null;
  localPeerId: string | null;
  localSpeaking: boolean;
  participants: Participant[];
  signalingCounters: {
    sent: { offer: number; answer: number; ice: number };
    recv: { offer: number; answer: number; ice: number };
  };

  speakerDeviceId: string;
  outputVolume: number;

  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
  screenOn: boolean;
  localScreenStream: MediaStream | null;
  remoteVideoStreams: Map<string, MediaStream>;
  shareAudioMuted: boolean;
  shareAudioVolume: number;
  onToggleShareAudio: () => void;
  onShareAudioVolumeChange: (v: number) => void;

  onPlaybackBlocked?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null);
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false);

  const status = useMemo(() => {
    if (!props.wsOpen) return "offline";
    if (!props.joinedVoiceKey) return "not in voice";
    return "connected";
  }, [props.joinedVoiceKey, props.wsOpen]);

  const tiles = useMemo(
    () =>
      props.participants.map((participant) => {
        const isLocal = participant.peerId === props.localPeerId;
        const stream = isLocal ? props.localScreenStream : (props.remoteVideoStreams.get(participant.peerId) ?? null);
        return { ...participant, isLocal, stream };
      }),
    [props.localPeerId, props.localScreenStream, props.participants, props.remoteVideoStreams]
  );

  useEffect(() => {
    if (!focusedPeerId) return;
    if (tiles.some((t) => t.peerId === focusedPeerId)) return;
    setFocusedPeerId(null);
  }, [focusedPeerId, tiles]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const root = panelRef.current;
      const elem = document.fullscreenElement;
      if (!root || !elem) {
        setIsVideoFullscreen(false);
        return;
      }
      setIsVideoFullscreen(elem instanceof HTMLVideoElement && root.contains(elem));
    };
    handleFullscreenChange();
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  async function toggleFullscreen() {
    const root = panelRef.current;
    if (!root) return;

    if (document.fullscreenElement) {
      if (root.contains(document.fullscreenElement)) {
        await document.exitFullscreen();
      }
      return;
    }

    const focusedVideo = root.querySelector(".voiceTileFocused .voiceTileVideoEl") as HTMLVideoElement | null;
    const firstSharedVideo = root.querySelector(".voiceTileVideoEl") as HTMLVideoElement | null;
    const target = focusedVideo ?? firstSharedVideo;
    if (!target) return;
    await target.requestFullscreen();
  }

  async function unlockSharePlayback() {
    const root = panelRef.current;
    if (!root) return;
    const videos = Array.from(root.querySelectorAll(".voiceTileVideoEl")) as HTMLVideoElement[];
    await Promise.all(
      videos.map(async (video) => {
        try {
          await video.play();
        } catch {
          props.onPlaybackBlocked?.();
        }
      })
    );
  }

  function handleToggleShareAudio() {
    props.onToggleShareAudio();
    // Run inside user gesture from FAB click to satisfy autoplay policies.
    void unlockSharePlayback();
  }

  const isFocused = Boolean(focusedPeerId);
  const hasActiveShare = Boolean(props.localScreenStream) || props.remoteVideoStreams.size > 0;
  const hasRemoteShare = props.remoteVideoStreams.size > 0;
  const renderedTiles = focusedPeerId ? tiles.filter((t) => t.peerId === focusedPeerId) : tiles;

  return (
    <div className="panel mainPanel" ref={panelRef}>
      {!isFocused ? (
        <div className="panelHeader">
          <div>
            <div style={{ fontWeight: 700 }}>{props.voiceChannelId ? `🔊 ${props.voiceChannelId}` : "Voice"}</div>
            <div className="muted">
              {status} {props.localPeerId ? `• ${props.localPeerId.slice(0, 8)}` : ""}
            </div>
            <div className="signalBadge muted">
              tx o/a/i: {props.signalingCounters.sent.offer}/{props.signalingCounters.sent.answer}/{props.signalingCounters.sent.ice} | rx
              o/a/i: {props.signalingCounters.recv.offer}/{props.signalingCounters.recv.answer}/{props.signalingCounters.recv.ice}
            </div>
          </div>
          <span className="pill">
            <VoiceRing speaking={props.localSpeaking} /> you
          </span>
        </div>
      ) : null}

      <div className={`panelBody ${isFocused ? "voicePanelBodyFullFocus" : "voicePanelBodyFocused"}`}>
        {!isFocused ? (
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <div className="muted">Screen share previews appear on participant cards.</div>
            <div className="row">
              <button className="btn btnPrimary" onClick={props.onStartScreenShare} disabled={!props.joinedVoiceKey || props.screenOn}>
                Start share
              </button>
              <button className="btn" onClick={props.onStopScreenShare} disabled={!props.screenOn}>
                Stop
              </button>
            </div>
          </div>
        ) : (
          <div className="voiceFocusHint">Focused view. Click the card to exit.</div>
        )}
        <div className={`voiceTilesGrid ${isFocused ? "voiceTilesGridFullPanel" : ""}`}>
          {renderedTiles.length === 0 ? (
            <div className="muted">No one is connected yet.</div>
          ) : (
            renderedTiles.map((tile) => (
              <ParticipantTile
                key={tile.peerId}
                displayName={tile.displayName}
                peerId={tile.peerId}
                speaking={tile.speaking}
                isLocal={tile.isLocal}
                connState={tile.connState}
                iceState={tile.iceState}
                micOn={tile.micOn}
                deafened={tile.deafened}
                stream={tile.stream}
                muted={tile.isLocal ? true : props.shareAudioMuted}
                volume={tile.isLocal ? 0 : props.shareAudioVolume}
                onPlaybackBlocked={props.onPlaybackBlocked}
                focused={tile.peerId === focusedPeerId}
                onToggleFocus={() => setFocusedPeerId((prev) => (prev === tile.peerId ? null : tile.peerId))}
              />
            ))
          )}
        </div>
      </div>
      {hasActiveShare ? (
        <div className="voiceFabStack">
          {hasRemoteShare ? (
            <div className="voiceAudioFabGroup">
              <div className="voiceVolumeSliderWrap" title={`Share volume: ${Math.round(props.shareAudioVolume * 100)}%`}>
                <input
                  className="voiceVolumeSlider"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(props.shareAudioVolume * 100)}
                  onChange={(e) => props.onShareAudioVolumeChange(Number(e.target.value) / 100)}
                  aria-label="Share volume"
                />
              </div>
              <button
                type="button"
                className="voiceFullscreenFab"
                onClick={handleToggleShareAudio}
                title={props.shareAudioMuted ? "Unmute share audio" : "Mute share audio"}
                aria-label={props.shareAudioMuted ? "Unmute share audio" : "Mute share audio"}
              >
                {props.shareAudioMuted ? "🔇" : "🔊"}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="voiceFullscreenFab"
            onClick={() => void toggleFullscreen()}
            title={isVideoFullscreen ? "Exit video fullscreen" : "Enter video fullscreen"}
            aria-label={isVideoFullscreen ? "Exit video fullscreen" : "Enter video fullscreen"}
          >
            {isVideoFullscreen ? "⤢" : "⛶"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ParticipantTile(props: {
  displayName: string;
  peerId: string;
  speaking: boolean;
  isLocal: boolean;
  connState?: RTCPeerConnectionState;
  iceState?: RTCIceConnectionState;
  micOn: boolean;
  deafened: boolean;
  stream: MediaStream | null;
  muted: boolean;
  volume: number;
  onPlaybackBlocked?: () => void;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  const title = props.isLocal ? `${props.displayName} (you)` : props.displayName;
  const avatar = (props.displayName || "?").slice(0, 1).toUpperCase();

  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = props.stream;
  }, [props.stream]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.muted = props.muted;
    ref.current.volume = Math.max(0, Math.min(1, props.volume));
  }, [props.muted, props.volume]);

  useEffect(() => {
    if (!ref.current || !props.stream || props.muted) return;
    ref.current
      .play()
      .catch(() => {
        props.onPlaybackBlocked?.();
      });
  }, [props.muted, props.stream, props.onPlaybackBlocked]);

  return (
    <button
      type="button"
      className={`voiceTile ${props.stream ? "voiceTileVideo" : "voiceTileCard"} ${props.speaking ? "voiceTileSpeaking" : ""} ${props.focused ? "voiceTileFocused" : ""}`}
      title={props.peerId}
      onClick={props.onToggleFocus}
    >
      {props.stream ? <video className="voiceTileVideoEl" ref={ref} autoPlay playsInline muted={props.muted} /> : null}
      {!props.stream ? (
        <div className="voiceTileCardBody">
          <div className="voiceTileAvatar">{avatar}</div>
        </div>
      ) : null}
      <div className="muted" style={{ position: "absolute", bottom: 8, left: 8, fontSize: 11 }}>
        {title} • {props.micOn ? "mic" : "mic off"} {props.deafened ? "• deaf" : ""}
      </div>
    </button>
  );
}


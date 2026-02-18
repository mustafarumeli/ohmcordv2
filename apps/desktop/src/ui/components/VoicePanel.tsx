import React, { useEffect, useMemo, useRef } from "react";
import { VoiceRing } from "./VoiceRing";

export type Participant = {
  peerId: string;
  displayName: string;
  speaking: boolean;
  connState?: RTCPeerConnectionState;
  iceState?: RTCIceConnectionState;
};

export function VoicePanel(props: {
  voiceChannelId: string | null;
  wsOpen: boolean;
  joinedVoiceKey: string | null;
  localPeerId: string | null;
  localSpeaking: boolean;
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

  onPlaybackBlocked?: () => void;
}) {
  const status = useMemo(() => {
    if (!props.wsOpen) return "offline";
    if (!props.joinedVoiceKey) return "not in voice";
    return "connected";
  }, [props.joinedVoiceKey, props.wsOpen]);

  return (
    <div className="panel mainPanel">
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

      <div className="panelBody">
        <div className="voiceGrid">
          <div className="panel subPanel">
            <div className="panelHeader">
              <div>
                <div style={{ fontWeight: 700 }}>Voice</div>
                <div className="muted">Connected members</div>
              </div>
            </div>
            <div className="panelBody">
              <div className="muted">Use the bottom bar to start/stop mic and open settings.</div>
            </div>
          </div>

          <div className="panel subPanel voiceScreens">
            <div className="panelHeader">
              <div>
                <div style={{ fontWeight: 700 }}>Screens</div>
                <div className="muted">Local + remote shares</div>
              </div>
              <div className="row">
                <button className="btn btnPrimary" onClick={props.onStartScreenShare} disabled={!props.joinedVoiceKey || props.screenOn}>
                  Start share
                </button>
                <button className="btn" onClick={props.onStopScreenShare} disabled={!props.screenOn}>
                  Stop
                </button>
              </div>
            </div>
            <div className="panelBody">
              <div className="videoGrid">
                {props.localScreenStream ? <VideoTile label="You (local)" stream={props.localScreenStream} /> : <div className="muted">No local share</div>}
                {[...props.remoteVideoStreams.entries()].map(([peerId, stream]) => (
                  <VideoTile key={peerId} label={`Remote: ${peerId}`} stream={stream} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
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


import React, { useEffect, useMemo, useRef } from "react";

function RemoteAudioEl(props: {
  peerId: string;
  stream: MediaStream;
  speakerDeviceId: string;
  volume: number;
  deafened: boolean;
  onPlaybackBlocked?: () => void;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = props.stream;
    el.muted = props.deafened;
    el.volume = props.volume;
    const sinkAudio = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (props.speakerDeviceId !== "default" && typeof sinkAudio.setSinkId === "function") {
      void sinkAudio.setSinkId(props.speakerDeviceId).catch(() => props.onPlaybackBlocked?.());
    }
    void el.play().catch(() => props.onPlaybackBlocked?.());
  }, [props.deafened, props.onPlaybackBlocked, props.speakerDeviceId, props.stream, props.volume]);

  return <audio ref={ref} autoPlay playsInline data-peerid={props.peerId} />;
}

export function RemoteAudioRack(props: {
  streams: Map<string, MediaStream>;
  speakerDeviceId: string;
  volume: number;
  deafened?: boolean;
  onPlaybackBlocked?: () => void;
}) {
  const list = useMemo(() => [...props.streams.entries()], [props.streams]);
  const deafened = props.deafened ?? false;
  return (
    <div style={{ display: "none" }}>
      {list.map(([peerId, stream]) => (
        <RemoteAudioEl
          key={peerId}
          peerId={peerId}
          stream={stream}
          speakerDeviceId={props.speakerDeviceId}
          volume={props.volume}
          deafened={deafened}
          onPlaybackBlocked={props.onPlaybackBlocked}
        />
      ))}
    </div>
  );
}


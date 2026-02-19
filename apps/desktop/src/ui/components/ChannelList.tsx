import React, { useEffect, useMemo, useRef, useState } from "react";

export type ChannelType = "text" | "voice";

export type ChannelSummary = {
  id: string;
  name: string;
  type: ChannelType;
};

export type ChannelParticipant = {
  peerId: string;
  displayName: string;
  speaking: boolean;
  micOn: boolean;
  deafened: boolean;
};

export function ChannelList(props: {
  channels: ChannelSummary[];
  selectedChannelId: string | null;
  unreadByChannelId: Record<string, number>;
  onSelect: (channelId: string) => void;
  localPeerId?: string | null;
  participantsByChannelId: Record<string, ChannelParticipant[]>;
  peerVolumes: Record<string, number>;
  onPeerVolumeChange: (peerId: string, volume: number) => void;
  disabled?: boolean;
}) {
  const list = useMemo(() => {
    const next = [...props.channels];
    next.sort((a, b) => {
      if (a.type !== b.type) return a.type === "text" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return next;
  }, [props.channels]);
  const [volumePopover, setVolumePopover] = useState<{ peer: ChannelParticipant; x: number; y: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!volumePopover) return;
    const onPointerDown = (evt: MouseEvent) => {
      const el = popoverRef.current;
      if (!el) return;
      if (!el.contains(evt.target as Node)) setVolumePopover(null);
    };
    const onEsc = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") setVolumePopover(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [volumePopover]);

  return (
    <>
      <div className="channelList">
        {list.length === 0 ? <div className="muted">No channels</div> : null}
        {list.map((c) => {
          const unread = c.type === "text" ? Math.max(0, Math.floor(props.unreadByChannelId[c.id] ?? 0)) : 0;
          return (
          <div key={c.id}>
            <button
              className={`channelItem ${props.selectedChannelId === c.id ? "channelItemActive" : ""}`}
              onClick={() => props.onSelect(c.id)}
              disabled={props.disabled}
              title={c.id}
            >
              <span className="channelHash">{c.type === "voice" ? "🔊" : "#"}</span>
              <span className="channelName">{c.name}</span>
              {unread > 0 ? <span className="channelUnreadBadge">{unread > 99 ? "99+" : unread}</span> : null}
            </button>

            {c.type === "voice" ? (
              <div className="channelParticipants">
                {(props.participantsByChannelId[c.id] ?? []).map((p) => (
                  <div
                    key={p.peerId}
                    className="channelParticipantItem"
                    title={p.peerId === props.localPeerId ? p.peerId : `${p.peerId} • sag tik: ses ayari`}
                    onContextMenu={(e) => {
                      if (p.peerId === props.localPeerId) return;
                      e.preventDefault();
                      const popoverWidth = 250;
                      setVolumePopover({
                        peer: p,
                        x: Math.max(8, Math.min(e.clientX - 150, window.innerWidth - popoverWidth - 8)),
                        y: Math.max(8, e.clientY - 24)
                      });
                    }}
                  >
                    <span className={p.speaking ? "miniRing miniRingOn" : "miniRing"} />
                    <span className="channelParticipantAvatar">{(p.displayName || "?").slice(0, 1).toUpperCase()}</span>
                    <span className="channelParticipantName">{p.displayName}</span>
                    {p.peerId === props.localPeerId ? null : (
                      <span className="muted" style={{ fontSize: 12 }} title={p.micOn ? "Mikrofon acik" : "Mikrofon kapali"}>
                        {p.micOn ? "🎤" : "🔇"}
                      </span>
                    )}
                    {p.peerId === props.localPeerId || !p.deafened ? null : (
                      <span className="muted" style={{ fontSize: 12 }} title="Kulaklik kapali">
                        🔕
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
        })}
      </div>

      {volumePopover ? (
        <div
          className="peerVolumePopover"
          ref={popoverRef}
          style={{ left: volumePopover.x, top: volumePopover.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="peerVolumeModalClose" onClick={() => setVolumePopover(null)} aria-label="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
          <div className="peerVolumePopoverName">{volumePopover.peer.displayName}</div>
          <div className="settingsSliderRow">
            <input
              className="settingsSlider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round((props.peerVolumes[volumePopover.peer.peerId] ?? 1) * 100)}
              onChange={(e) => props.onPeerVolumeChange(volumePopover.peer.peerId, Number(e.target.value) / 100)}
            />
            <div className="settingsSliderValue">{Math.round((props.peerVolumes[volumePopover.peer.peerId] ?? 1) * 100)}%</div>
          </div>
        </div>
      ) : null}
    </>
  );
}


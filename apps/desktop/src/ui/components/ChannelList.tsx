import React, { useMemo } from "react";

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
};

export function ChannelList(props: {
  channels: ChannelSummary[];
  selectedChannelId: string | null;
  onSelect: (channelId: string) => void;
  joinedVoiceKey: string | null;
  participants: ChannelParticipant[];
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

  return (
    <div className="channelList">
      {list.length === 0 ? <div className="muted">No channels</div> : null}
      {list.map((c) => (
        <div key={c.id}>
          <button
            className={`channelItem ${props.selectedChannelId === c.id ? "channelItemActive" : ""}`}
            onClick={() => props.onSelect(c.id)}
            disabled={props.disabled}
            title={c.id}
          >
            <span className="channelHash">{c.type === "voice" ? "🔊" : "#"}</span>
            <span className="channelName">{c.name}</span>
          </button>

          {c.type === "voice" && props.joinedVoiceKey === c.id ? (
            <div className="channelParticipants">
              {props.participants.map((p) => (
                <div key={p.peerId} className="channelParticipantItem" title={p.peerId}>
                  <span className={p.speaking ? "miniRing miniRingOn" : "miniRing"} />
                  <span className="channelParticipantAvatar">{(p.displayName || "?").slice(0, 1).toUpperCase()}</span>
                  <span className="channelParticipantName">{p.displayName}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}


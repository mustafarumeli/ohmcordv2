import React from "react";
import { VoiceSettingsPopover } from "./VoiceSettingsPopover";

function MicIcon(props: { off: boolean }) {
  return (
    <svg className="iconSvg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 11a7 7 0 0 1-14 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 18v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 21h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {props.off ? (
        <path
          d="M4 4l16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function HeadphonesIcon(props: { off: boolean }) {
  return (
    <svg className="iconSvg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 12a8 8 0 0 1 16 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 12v6a2 2 0 0 0 2 2h1v-8H6a2 2 0 0 0-2 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 12v6a2 2 0 0 1-2 2h-1v-8h1a2 2 0 0 1 2 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {props.off ? (
        <path
          d="M4 4l16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function DisconnectIcon() {
  return (
    <svg className="iconSvg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 15c2.6-2.6 5.9-4 9-4s6.4 1.4 9 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.2 15.8 6.9 19a2 2 0 0 0 2.7.9l2.1-1a3 3 0 0 1 2.6 0l2.1 1a2 2 0 0 0 2.7-.9l1.7-3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BottomBar(props: {
  displayName: string;
  joinedVoiceKey: string | null;

  voiceOn: boolean;
  deafened: boolean;
  canUseVoiceActions: boolean;

  settingsOpen: boolean;
  onToggleSettings: () => void;
  onCloseSettings: () => void;

  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onDisconnectVoice: () => void;

  rnnoiseOn: boolean;
  setRnnoiseOn: (v: boolean) => void;

  micDevices: MediaDeviceInfo[];
  micDeviceId: string;
  setMicDeviceId: (id: string) => void;

  speakerDevices: MediaDeviceInfo[];
  speakerDeviceId: string;
  setSpeakerDeviceId: (id: string) => void;

  inputVolume: number;
  setInputVolume: (v: number) => void;
  outputVolume: number;
  setOutputVolume: (v: number) => void;
}) {
  return (
    <div className="bottomBar">
      <div className="bottomUser">
        <div className="bottomAvatar">{props.displayName.slice(0, 1).toUpperCase()}</div>
        <div className="bottomUserMeta">
          <div className="bottomUserName">{props.displayName}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {props.joinedVoiceKey ? `voice: ${props.joinedVoiceKey}` : "not in voice"}
          </div>
        </div>
      </div>

      <div className="bottomActions">
        <button
          className={`iconBtn ${props.voiceOn ? "iconBtnOn" : "iconBtnDanger"}`}
          onClick={props.onToggleMic}
          disabled={!props.canUseVoiceActions}
          aria-label={props.voiceOn ? "Mute microphone" : "Unmute microphone"}
        >
          <MicIcon off={!props.voiceOn} />
        </button>
        <button
          className={`iconBtn ${props.deafened ? "iconBtnDanger" : ""}`}
          onClick={props.onToggleDeafen}
          disabled={!props.canUseVoiceActions}
          aria-label={props.deafened ? "Undeafen (enable speakers)" : "Deafen (mute speakers)"}
        >
          <HeadphonesIcon off={props.deafened} />
        </button>
        {props.joinedVoiceKey ? (
          <button className="iconBtn iconBtnDanger" onClick={props.onDisconnectVoice} aria-label="Disconnect from voice" title="Disconnect">
            <DisconnectIcon />
          </button>
        ) : null}
        <div className="settingsWrap">
          <button className={`iconBtn ${props.settingsOpen ? "iconBtnOn" : ""}`} onClick={props.onToggleSettings} aria-label="Voice settings">
            ⚙️
          </button>
          <VoiceSettingsPopover
            open={props.settingsOpen}
            onClose={props.onCloseSettings}
            rnnoiseOn={props.rnnoiseOn}
            setRnnoiseOn={props.setRnnoiseOn}
            micDevices={props.micDevices}
            micDeviceId={props.micDeviceId}
            setMicDeviceId={props.setMicDeviceId}
            speakerDevices={props.speakerDevices}
            speakerDeviceId={props.speakerDeviceId}
            setSpeakerDeviceId={props.setSpeakerDeviceId}
            inputVolume={props.inputVolume}
            setInputVolume={props.setInputVolume}
            outputVolume={props.outputVolume}
            setOutputVolume={props.setOutputVolume}
          />
        </div>
      </div>
    </div>
  );
}


import React, { useMemo } from "react";

export function VoiceSettingsPopover(props: {
  open: boolean;
  onClose: () => void;

  rnnoiseOn: boolean;
  setRnnoiseOn: (v: boolean) => void;

  micDevices: MediaDeviceInfo[];
  micDeviceId: string;
  setMicDeviceId: (id: string) => void;

  speakerDevices: MediaDeviceInfo[];
  speakerDeviceId: string;
  setSpeakerDeviceId: (id: string) => void;

  inputVolume: number; // 0..2
  setInputVolume: (v: number) => void;
  outputVolume: number; // 0..1
  setOutputVolume: (v: number) => void;
}) {
  const micOptions = useMemo(() => props.micDevices.filter((d) => d.deviceId), [props.micDevices]);
  const speakerOptions = useMemo(() => props.speakerDevices.filter((d) => d.deviceId), [props.speakerDevices]);

  if (!props.open) return null;

  return (
    <div className="settingsPopover" role="dialog" aria-label="Voice settings">
      <div className="settingsRow settingsTop">
        <div>
          <div className="settingsTitle">Voice Settings</div>
          <div className="muted">Devices & levels</div>
        </div>
        <button className="btn settingsClose" onClick={props.onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="settingsDivider" />

      <div className="settingsSection">
        <div className="settingsLabel">Input Device</div>
        <select className="input" value={props.micDeviceId} onChange={(e) => props.setMicDeviceId(e.target.value)}>
          <option value="default">Default</option>
          {micOptions.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Mic ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
      </div>

      <div className="settingsSection">
        <div className="settingsLabel">Input Volume</div>
        <div className="settingsSliderRow">
          <input
            className="settingsSlider"
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={props.inputVolume}
            onChange={(e) => props.setInputVolume(Number(e.target.value))}
          />
          <div className="settingsSliderValue">{Math.round(props.inputVolume * 100)}%</div>
        </div>
      </div>

      <div className="settingsDivider" />

      <div className="settingsSection">
        <div className="settingsLabel">Output Device</div>
        <select className="input" value={props.speakerDeviceId} onChange={(e) => props.setSpeakerDeviceId(e.target.value)}>
          <option value="default">Default</option>
          {speakerOptions.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Speaker ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
      </div>

      <div className="settingsSection">
        <div className="settingsLabel">Output Volume</div>
        <div className="settingsSliderRow">
          <input
            className="settingsSlider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={props.outputVolume}
            onChange={(e) => props.setOutputVolume(Number(e.target.value))}
          />
          <div className="settingsSliderValue">{Math.round(props.outputVolume * 100)}%</div>
        </div>
      </div>

      <div className="settingsDivider" />

      <label className="settingsToggle">
        <input type="checkbox" checked={props.rnnoiseOn} onChange={(e) => props.setRnnoiseOn(e.target.checked)} />
        <span>RNNoise (VAD)</span>
      </label>
    </div>
  );
}


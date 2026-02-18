export async function startVoicePipeline(opts: {
  rnnoiseOn: boolean;
  deviceId?: string;
  inputGain?: number;
  onSpeaking: (speaking: boolean) => void;
}) {
  const requestedAudioConstraints: any = {
    ...(opts.deviceId && opts.deviceId !== "default" ? { deviceId: { exact: opts.deviceId } } : {}),
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    ...(opts.rnnoiseOn ? { voiceIsolation: true } : {}),
    advanced: [
      {
        googNoiseSuppression: true,
        googHighpassFilter: true,
        googAutoGainControl: true,
        googEchoCancellation: true,
        googTypingNoiseDetection: true
      }
    ]
  };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: requestedAudioConstraints,
    video: false
  });

  const micTrack = stream.getAudioTracks()[0];
  if (!micTrack) throw new Error("No microphone track");

  const ctx = new AudioContext({ sampleRate: 48000 });
  const source = ctx.createMediaStreamSource(new MediaStream([micTrack]));

  // Single path: source -> worklet (RNNoise/VAD) -> userGain -> gateGain -> dest (send).
  // The gate is an aggressive way to cut background noise when not speaking.
  const userGain = ctx.createGain();
  userGain.gain.value = typeof opts.inputGain === "number" ? opts.inputGain : 1;
  const gateGain = ctx.createGain();
  const GATE_FLOOR = 0.02; // ~-34dB when not speaking (more aggressive)
  const GATE_HOLD_SEC = 0.5; // keep gate open after speech to avoid chattering
  const GATE_ATTACK_SEC = 0.012;
  const GATE_RELEASE_SEC = 0.08;
  gateGain.gain.value = 1;
  const dest = ctx.createMediaStreamDestination();

  const workletUrl = new URL("./worklet/rnnoise-vad-processor.js", import.meta.url);
  await ctx.audioWorklet.addModule(workletUrl.toString());
  const node = new AudioWorkletNode(ctx, "rnnoise-vad-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });

  node.port.postMessage({ type: "config", enabled: opts.rnnoiseOn, vadThreshold: 0.6 });
  let speakingEventCount = 0;
  let lastSpeakingAt = ctx.currentTime;
  node.port.onmessage = (evt) => {
    const data = evt.data as { type?: string; speaking?: boolean };
    if (data?.type === "speaking" && typeof data.speaking === "boolean") {
      speakingEventCount += 1;
      const now = ctx.currentTime;
      let appliedTarget: number | null = null;
      let held = false;
      if (data.speaking) {
        lastSpeakingAt = now;
        appliedTarget = 1;
        gateGain.gain.setTargetAtTime(appliedTarget, now, GATE_ATTACK_SEC);
      } else {
        const since = now - lastSpeakingAt;
        if (since >= GATE_HOLD_SEC) {
          appliedTarget = GATE_FLOOR;
          gateGain.gain.setTargetAtTime(appliedTarget, now, GATE_RELEASE_SEC);
        } else {
          held = true;
        }
      }
      opts.onSpeaking(data.speaking);
    }
  };

  source.connect(node).connect(userGain).connect(gateGain).connect(dest);

  const sendTrack = dest.stream.getAudioTracks()[0];
  if (!sendTrack) throw new Error("No send track");

  // Needed in Chromium to start audio graph.
  if (ctx.state !== "running") await ctx.resume();

  const stop = () => {
    try {
      node.port.postMessage({ type: "stop" });
    } catch {
      // ignore
    }
    node.disconnect();
    source.disconnect();
    userGain.disconnect();
    gateGain.disconnect();
    dest.disconnect();
    micTrack.stop();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  const setInputGain = (v: number) => {
    const next = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1;
    userGain.gain.setTargetAtTime(next, ctx.currentTime, 0.01);
  };

  return { track: sendTrack, stop, setInputGain };
}


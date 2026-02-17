export async function startVoicePipeline(opts: {
  rnnoiseOn: boolean;
  deviceId?: string;
  onSpeaking: (speaking: boolean) => void;
}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId && opts.deviceId !== "default" ? { deviceId: { exact: opts.deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true
    },
    video: false
  });

  const micTrack = stream.getAudioTracks()[0];
  if (!micTrack) throw new Error("No microphone track");

  const ctx = new AudioContext({ sampleRate: 48000 });
  const source = ctx.createMediaStreamSource(new MediaStream([micTrack]));

  const workletUrl = new URL("./worklet/rnnoise-vad-processor.js", import.meta.url);
  await ctx.audioWorklet.addModule(workletUrl.toString());
  const node = new AudioWorkletNode(ctx, "rnnoise-vad-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });

  node.port.postMessage({ type: "config", enabled: opts.rnnoiseOn, vadThreshold: 0.6 });
  node.port.onmessage = (evt) => {
    const data = evt.data as { type?: string; speaking?: boolean };
    if (data?.type === "speaking" && typeof data.speaking === "boolean") {
      opts.onSpeaking(data.speaking);
    }
  };

  const dest = ctx.createMediaStreamDestination();
  source.connect(node).connect(dest);

  const processedTrack = dest.stream.getAudioTracks()[0];
  if (!processedTrack) throw new Error("No processed track");

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
    dest.disconnect();
    micTrack.stop();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return { track: processedTrack, stop };
}


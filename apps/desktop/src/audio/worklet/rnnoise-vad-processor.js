// RNNoise expects 480 samples per frame @ 48kHz (10ms).
const FRAME_SIZE = 480;
const HANGOVER_FRAMES = 25; // ~250ms
const RMS_VAD_THRESHOLD = 0.01; // normalized float RMS

class RNNoiseVadProcessor extends AudioWorkletProcessor {
  config = { enabled: true, vadThreshold: 0.6 };

  frame = new Float32Array(FRAME_SIZE);
  framePos = 0;

  outBuf = new Float32Array(FRAME_SIZE * 8);
  outRead = 0;
  outWrite = 0;
  outSize = 0;

  hangover = 0;
  speaking = false;

  constructor() {
    super();

    this.port.onmessage = (evt) => {
      const msg = evt.data;
      if (msg?.type === "config") {
        if (typeof msg.enabled === "boolean") this.config.enabled = msg.enabled;
        if (typeof msg.vadThreshold === "number") this.config.vadThreshold = msg.vadThreshold;
      }
      if (msg?.type === "stop") {
        // no-op; kept for protocol compatibility
      }
    };
  }

  pushOut(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.outBuf[this.outWrite] = samples[i];
      this.outWrite = (this.outWrite + 1) % this.outBuf.length;
      if (this.outSize < this.outBuf.length) this.outSize++;
      else this.outRead = (this.outRead + 1) % this.outBuf.length;
    }
  }

  popOut() {
    if (this.outSize === 0) return null;
    const v = this.outBuf[this.outRead];
    this.outRead = (this.outRead + 1) % this.outBuf.length;
    this.outSize--;
    return v;
  }

  processFrame() {
    // Compute RMS for fallback VAD.
    let sum = 0;
    for (let i = 0; i < this.frame.length; i++) {
      const v = this.frame[i];
      sum += v * v;
    }
    const rmsIn = Math.sqrt(sum / this.frame.length);

    // Keep processing path stable in production builds without wasm module loading.
    this.pushOut(this.frame);
    const speechByRms = rmsIn >= RMS_VAD_THRESHOLD;
    if (speechByRms) this.hangover = HANGOVER_FRAMES;
    else this.hangover = Math.max(0, this.hangover - 1);

    const nextSpeaking = this.hangover > 0;
    if (nextSpeaking !== this.speaking) {
      this.speaking = nextSpeaking;
      this.port.postMessage({ type: "speaking", speaking: this.speaking });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    for (let i = 0; i < output.length; i++) {
      const s = input[i] ?? 0;
      this.frame[this.framePos++] = s;
      if (this.framePos === FRAME_SIZE) {
        this.processFrame();
        this.framePos = 0;
      }
      const o = this.popOut();
      output[i] = o ?? s;
    }
    return true;
  }
}

registerProcessor("rnnoise-vad-processor", RNNoiseVadProcessor);


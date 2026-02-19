let ctx: AudioContext | null = null;

function getCtx() {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

function beep(freq: number, durationMs: number, gainValue: number) {
  try {
    const audioCtx = getCtx();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000);
  } catch {
    // ignore
  }
}

export async function unlockUiSounds() {
  try {
    const audioCtx = getCtx();
    if (audioCtx.state !== "running") await audioCtx.resume();
  } catch {
    // ignore
  }
}

export function playUiSound(kind: "join" | "leave" | "message" | "sent") {
  try {
    if (getCtx().state !== "running") return;
    if (kind === "join") {
      beep(700, 90, 0.06);
      return;
    }
    if (kind === "leave") {
      beep(420, 110, 0.06);
      return;
    }
    if (kind === "message") {
      beep(840, 70, 0.05);
      return;
    }
    beep(620, 55, 0.045);
  } catch {
    // ignore
  }
}

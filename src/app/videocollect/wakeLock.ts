let wakeLockSentinel: any = null;
let visibilityHandler: (() => void) | null = null;
let audioCtx: AudioContext | null = null;
let osc: OscillatorNode | null = null;
let gainNode: GainNode | null = null;
let isActive = false;

export async function acquireWakeLock(): Promise<void> {
  if (isActive) return;
  try {
    if ('wakeLock' in navigator) {
      // @ts-ignore - modern browsers expose navigator.wakeLock
      wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
      visibilityHandler = async () => {
        if (document.visibilityState === 'visible' && !wakeLockSentinel) {
          try { wakeLockSentinel = await (navigator as any).wakeLock.request('screen'); } catch { /* ignore */ }
        }
      };
      document.addEventListener('visibilitychange', visibilityHandler);
      isActive = true;
      return;
    }
  } catch (e) {
    console.warn('[wakeLock] navigator.wakeLock request failed', e);
  }

  // Fallback: attempt to play a tiny silent audio via WebAudio (requires user gesture)
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    const ctx = audioCtx as AudioContext;
    osc = ctx.createOscillator();
    gainNode = ctx.createGain();
    // very low gain to avoid audible sound
    gainNode.gain.value = 0.00001;
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.start();
    isActive = true;
    return;
  } catch (e) {
    console.warn('[wakeLock] fallback audio method failed', e);
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    if (wakeLockSentinel) {
      try { await wakeLockSentinel.release?.(); } catch { /* ignore */ }
      wakeLockSentinel = null;
    }
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
  } catch (e) {
    console.warn('[wakeLock] release error', e);
  }

  try {
    if (osc) {
      try { osc.stop(); } catch { /* ignore */ }
      osc.disconnect();
      osc = null;
    }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
    if (audioCtx) { try { audioCtx.close(); } catch { } audioCtx = null; }
  } catch (e) {
    console.warn('[wakeLock] audio cleanup error', e);
  }

  isActive = false;
}

export function isWakeLockActive(): boolean {
  return isActive;
}

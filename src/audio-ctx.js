// AudioContext + time-stretch worklet lifecycle. Leaf layer: these compose each
// other and touch only shared state (S/transport) + native Web Audio APIs — no
// mix/transport/streaming calls — so they extract cleanly ahead of that web.
import { S, transport } from './state.js';

// Same-dir as main.js (both in src/), so ../assets/ resolves identically.
const WORKLET_URL = new URL('../assets/stretch-worklet.js', import.meta.url).href;

export function ensureCtx() {
    if (!S.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        S.audioCtx = new AC();
    }
    return S.audioCtx;
}

// Resume the AudioContext if suspended, swallowing BOTH a synchronous
// throw and the async rejection AudioContext.resume() produces when the
// browser blocks resume outside a user gesture.
export function resumeCtx() {
    if (!S.audioCtx || S.audioCtx.state !== 'suspended') return;
    try {
        const p = S.audioCtx.resume();
        if (p && p.catch) p.catch(() => {});
    } catch (_) { /* resume unsupported */ }
}

// Register the time-stretch worklet module once. Resolves to true when the
// worklet is usable, false to signal the caller to fall back to legacy
// (pitch-coupling) playback. Memoised; a failed load is retried next song.
export function ensureWorklet() {
    if (S.workletReady) return Promise.resolve(true);
    if (S.workletModulePromise) return S.workletModulePromise;
    if (!S.audioCtx || !S.audioCtx.audioWorklet || !WORKLET_URL) return Promise.resolve(false);
    S.workletModulePromise = S.audioCtx.audioWorklet.addModule(WORKLET_URL)
        .then(() => { S.workletReady = true; return true; })
        .catch((e) => {
            // Log once, not every song — a missing core asset route (404)
            // would otherwise spam the console on each load.
            if (!S.workletWarned) {
                console.warn('[stems] worklet module load failed; using legacy mode:', e);
                S.workletWarned = true;
            }
            S.workletModulePromise = null; // allow a retry on the next song
            return false;
        });
    return S.workletModulePromise;
}

// WSOLA's output lags by L output samples (worklet 'ready' reports L), which
// is L * rate of song time — but each grain is read L source samples AHEAD of
// the read frontier, which puts the content L of song time early. Net: the
// heard song position trails the frontier by L * (rate - 1) / sr. That is
// NEGATIVE below 1.0x (the stretched audio is ahead of the frontier clock) and
// exactly 0 at 1.0x, matching the worklet's pass-through there. Measured on the
// real worklet with a click train (tests/stretch-worklet-heard-time.test.mjs):
// within 1.5 ms at 0.5-1.5x, where the old L * rate was 16 ms off at every rate.
export function updateLatencyOffset() {
    if (S.useWorklet && S.audioCtx && S.workletLatencyOutSamples > 0
            && Math.abs(transport.rate - 1) > 1e-6) {
        S.latencyOffsetSec = (S.workletLatencyOutSamples / S.audioCtx.sampleRate) * (transport.rate - 1);
    } else {
        S.latencyOffsetSec = 0;
    }
}

// Recreate the AudioContext at a specific sampleRate (streaming needs native-rate
// PCM to avoid resampling). Returns false if the engine ignored the rate option.
export async function ensureCtxAtRate(rate) {
    ensureCtx();
    if (S.audioCtx && Math.abs(S.audioCtx.sampleRate - rate) < 1) return true;
    try { if (S.audioCtx) { const old = S.audioCtx; S.audioCtx = null; try { old.close(); } catch (_) {} } } catch (_) {}
    S.workletReady = false;
    S.workletModulePromise = null;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { S.audioCtx = new AC({ sampleRate: rate }); }
    catch (_) { try { S.audioCtx = new AC(); } catch (__) { return false; } }
    const ok = await ensureWorklet();
    // If the engine ignored the sampleRate option, we can't feed native-rate
    // PCM without resampling — refuse streaming and let the caller bail.
    return ok && !!S.audioCtx && Math.abs(S.audioCtx.sampleRate - rate) < 1;
}

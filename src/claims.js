// Automation claim snapshots and the claim fade. Pure: operates on the
// `claimSnapshots` Map (key `${claimId}:${id}` → { claimId, id, prevOn, prevVol })
// passed in by the caller — real-import tested in tests/claims.test.mjs.
//
// Claims stack: every claim on a stem carries the stem's pre-claim (user)
// state, and that state is only handed back once no claim still holds it.

// setTargetAtTime time constant: ~12 ms (3τ) to reach 95 % of the target.
export const CLAIM_FADE_TC_S = 0.004;

function snapshotKey(claimId, id) {
    return `${claimId}:${id}`;
}

function heldByOther(snapshots, claimId, id) {
    for (const entry of snapshots.values()) {
        if (entry.id === id && entry.claimId !== claimId) return entry;
    }
    return null;
}

// Record that `claimId` mutes `stem`. A no-op when this claim already holds
// the stem; when another claim holds it, copy that claim's pre-claim state
// (the stem's live state is already the automation mute, not the user's).
export function recordClaimMute(snapshots, claimId, stem) {
    const key = snapshotKey(claimId, stem.id);
    if (snapshots.has(key)) return;
    const other = heldByOther(snapshots, claimId, stem.id);
    snapshots.set(key, other
        ? { claimId, id: stem.id, prevOn: other.prevOn, prevVol: other.prevVol }
        : { claimId, id: stem.id, prevOn: stem.on, prevVol: stem.vol });
}

// Drop every entry of `claimId` and return the pre-claim state to apply for
// the stems no other claim still holds.
export function releaseClaim(snapshots, claimId) {
    const released = [];
    for (const [key, entry] of Array.from(snapshots.entries())) {
        if (entry.claimId !== claimId) continue;
        snapshots.delete(key);
        released.push(entry);
    }
    return released
        .filter(entry => !heldByOther(snapshots, claimId, entry.id))
        .map(entry => ({ id: entry.id, on: entry.prevOn, vol: entry.prevVol }));
}

// Move a GainNode to `target`: a short exponential approach when an
// AudioContext is available, an immediate set otherwise. The worklet-mode
// stand-in (makeStemGainHandle, src/mix.js) has no AudioParam automation,
// so it is also set directly.
export function fadeGain(gainNode, target, ctx) {
    const param = gainNode.gain;
    if (ctx && typeof param.setTargetAtTime === 'function') {
        param.cancelScheduledValues(ctx.currentTime);
        param.setTargetAtTime(target, ctx.currentTime, CLAIM_FADE_TC_S);
    } else {
        param.value = target;
    }
}

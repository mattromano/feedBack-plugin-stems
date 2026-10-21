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

// Release `claimId` and tell core, in that order. Core's
// audioSession.restoreStems() calls capabilities.release(), which emits
// `claim:released` synchronously, and Stems' handler for it (releaseClaim,
// then apply) would take this claim's snapshots — so the pre-claim states
// must be taken before `notifyCore` runs, leaving the handler nothing to do.
// A throwing `notifyCore` doesn't lose them.
export function restoreClaim(snapshots, claimId, notifyCore) {
    const states = releaseClaim(snapshots, claimId);
    if (typeof notifyCore === 'function') {
        try { notifyCore(); } catch (_) {}
    }
    return states;
}

// Drop every snapshot of `claimId` without restoring. A no-op when the id is
// missing.
export function clearClaim(snapshots, claimId) {
    if (!claimId) return;
    for (const [key, entry] of Array.from(snapshots.entries())) {
        if (entry.claimId === claimId) snapshots.delete(key);
    }
}

// What the song's saved mutes should record: a stem held by any claim reports
// that claim's pre-claim `prevOn` (stacked claims carry the same value), so an
// automation mute is never persisted; any other stem reports its own `on`.
export function persistableStems(stems, snapshots) {
    return stems.map((stem) => {
        for (const entry of snapshots.values()) {
            if (entry.id === stem.id) return { id: stem.id, on: entry.prevOn };
        }
        return { id: stem.id, on: stem.on };
    });
}

// A player change to a stem while claims hold it: update every claim's
// pre-claim state, so the last restore gives back the player's choice.
// Only a boolean `on` and a finite `vol` are taken; an unclaimed id is a no-op.
export function noteUserChange(snapshots, id, { on, vol } = {}) {
    for (const entry of snapshots.values()) {
        if (entry.id !== id) continue;
        if (typeof on === 'boolean') entry.prevOn = on;
        if (Number.isFinite(vol)) entry.prevVol = vol;
    }
}

// Claim-held stems that are live again (on, or with gain above 0): another
// plugin un-muted them under a claim (e.g. stem_mixer writes `on`/`gain`
// straight onto window.stems.stemState). Unclaimed stems are never returned.
export function stemsNeedingReassert(stems, snapshots) {
    const held = new Set();
    for (const entry of snapshots.values()) held.add(entry.id);
    return stems.filter(s => held.has(s.id)
        && (s.on || !!(s.gain && s.gain.gain && s.gain.gain.value > 0)));
}

// Coalesce repeated requests into one `run` per `schedule` turn.
export function coalesce(schedule, run) {
    let pending = false;
    return () => {
        if (pending) return;
        pending = true;
        schedule(() => {
            pending = false;
            run();
        });
    };
}

// Move a GainNode to `target`: a short exponential approach when an
// AudioContext is available, an immediate set otherwise. The worklet-mode
// stand-in (makeStemGainHandle, src/mix.js) has no AudioParam automation,
// so it is also set directly; the worklet ramps every gain change itself
// over ~12 ms (assets/stretch-worklet.js `_rampGains`), so it still fades.
export function fadeGain(gainNode, target, ctx) {
    const param = gainNode.gain;
    if (ctx && typeof param.setTargetAtTime === 'function') {
        param.cancelScheduledValues(ctx.currentTime);
        param.setTargetAtTime(target, ctx.currentTime, CLAIM_FADE_TC_S);
    } else {
        param.value = target;
    }
}

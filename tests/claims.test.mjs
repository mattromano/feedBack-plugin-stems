// Unit tests for src/claims.js — pure claim-snapshot stacking and the
// automation fade. Real ES-module import; the gain param is a recording fake
// (no AudioContext, nothing audible).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CLAIM_FADE_TC_S, recordClaimMute, releaseClaim, restoreClaim, clearClaim, fadeGain,
    persistableStems, noteUserChange, stemsNeedingReassert, coalesce, markPlayerOverride,
} from '../src/claims.js';

test('one claim: mute then restore gives the user\'s state back', () => {
    const m = new Map();
    const stem = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', stem);
    assert.deepEqual(releaseClaim(m, 'a'), [{ id: 'drums', on: true, vol: 0.8 }]);
    assert.equal(m.size, 0);
});

test('stacked claims: the first restore keeps the stem muted while the second holds it', () => {
    const m = new Map();
    const stem = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', stem);
    stem.on = false;
    recordClaimMute(m, 'b', stem);
    assert.deepEqual(releaseClaim(m, 'a'), []);
    assert.deepEqual(releaseClaim(m, 'b'), [{ id: 'drums', on: true, vol: 0.8 }]);
    assert.equal(m.size, 0);
});

test('re-muting under the same claim keeps the first snapshot', () => {
    const m = new Map();
    const stem = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', stem);
    stem.on = false;
    stem.vol = 0.3;
    recordClaimMute(m, 'a', stem);
    assert.equal(m.size, 1);
    assert.deepEqual(releaseClaim(m, 'a'), [{ id: 'drums', on: true, vol: 0.8 }]);
});

test('fadeGain ramps with a context and sets directly without one', () => {
    assert.equal(CLAIM_FADE_TC_S, 0.004);
    const calls = [];
    const node = {
        gain: {
            value: 1,
            cancelScheduledValues: (t) => calls.push(['cancelScheduledValues', t]),
            setTargetAtTime: (v, t, tc) => calls.push(['setTargetAtTime', v, t, tc]),
        },
    };
    fadeGain(node, 0, { currentTime: 0.5 });
    assert.deepEqual(calls, [
        ['cancelScheduledValues', 0.5],
        ['setTargetAtTime', 0, 0.5, 0.004],
    ]);

    const direct = { gain: { value: 1 } };
    fadeGain(direct, 0, null);
    assert.equal(direct.gain.value, 0);
});

test('fadeGain sets directly on a worklet gain handle that has no automation', () => {
    // makeStemGainHandle (src/mix.js) only exposes `.gain.value`.
    const handle = { gain: { value: 1 } };
    fadeGain(handle, 0.25, { currentTime: 0.5 });
    assert.equal(handle.gain.value, 0.25);
});

// ── Real-app bug: restore returned restoredIds: [] ─────────────────────────
// Core's audioSession.restoreStems() calls capabilities.release(), which emits
// `claim:released` synchronously; Stems' handler for it clears the claim's
// snapshots. The fake session below does the same, so a restore that reads
// the snapshots AFTER notifying core finds nothing to restore.

function fakeCore(snapshots, applied = []) {
    // Stems' participant `claim:released` handler, as wired in main.js:
    // releaseClaim, then apply what it returns (recorded in `applied`).
    const onClaimReleased = (detail) => {
        applied.push(...releaseClaim(snapshots, detail && detail.payload && detail.payload.claimId));
    };
    return {
        restoreStems({ claimId }) { onClaimReleased({ payload: { claimId } }); },
        release(claimId) { onClaimReleased({ payload: { claimId } }); },
    };
}

test('restore through core: one claim gives the stem back on at its previous volume', () => {
    const m = new Map();
    const session = fakeCore(m);
    const stem = { id: 'bass', on: true, vol: 0.7 };
    recordClaimMute(m, 'p5probe', stem);
    stem.on = false;
    const states = restoreClaim(m, 'p5probe', () => session.restoreStems({ claimId: 'p5probe' }));
    assert.deepEqual(states, [{ id: 'bass', on: true, vol: 0.7 }]);
    assert.equal(m.size, 0);
});

test('restore through core: stacked claims keep the stem muted until the last restore', () => {
    const m = new Map();
    const session = fakeCore(m);
    const stem = { id: 'bass', on: true, vol: 0.7 };
    recordClaimMute(m, 'a', stem);
    stem.on = false;
    recordClaimMute(m, 'b', stem);
    assert.deepEqual(restoreClaim(m, 'a', () => session.restoreStems({ claimId: 'a' })), []);
    assert.deepEqual(restoreClaim(m, 'b', () => session.restoreStems({ claimId: 'b' })),
        [{ id: 'bass', on: true, vol: 0.7 }]);
    assert.equal(m.size, 0);
});

test('restoreClaim still returns the states when notifying core throws', () => {
    const m = new Map();
    recordClaimMute(m, 'a', { id: 'bass', on: true, vol: 0.7 });
    assert.deepEqual(restoreClaim(m, 'a', () => { throw new Error('core down'); }),
        [{ id: 'bass', on: true, vol: 0.7 }]);
});

test('clearClaim drops only that claim and ignores a missing id', () => {
    const m = new Map();
    recordClaimMute(m, 'a', { id: 'bass', on: true, vol: 0.7 });
    recordClaimMute(m, 'b', { id: 'drums', on: true, vol: 1 });
    clearClaim(m, null);
    assert.equal(m.size, 2);
    clearClaim(m, 'a');
    assert.deepEqual(Array.from(m.values()).map(e => e.claimId), ['b']);
});

// ── A released claim gives back the player's state (final review C1) ──
// Core skips a restore as `overridden` after any player stems toggle, then the
// requester releases: `claim:released` must restore the snapshot.

test('released without a restore: the stem gets its pre-claim state back', () => {
    const m = new Map();
    const drums = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', drums);
    drums.on = false;
    noteUserChange(m, 'guitar', { on: false });   // another stem: no effect
    assert.deepEqual(releaseClaim(m, 'a'), [{ id: 'drums', on: true, vol: 0.8 }]);
    assert.equal(m.size, 0);
});

test('released without a restore, stacked: releasing one of two keeps the stem muted', () => {
    const m = new Map();
    const drums = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', drums);
    drums.on = false;
    recordClaimMute(m, 'b', drums);
    assert.deepEqual(releaseClaim(m, 'a'), []);
    assert.deepEqual(releaseClaim(m, 'b'), [{ id: 'drums', on: true, vol: 0.8 }]);
});

test('through core: override on another stem, restore skipped, release restores the stem', () => {
    const m = new Map();
    const applied = [];
    const core = fakeCore(m, applied);
    const drums = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'bab', drums);
    drums.on = false;
    noteUserChange(m, 'guitar', { on: false });   // player toggles guitar
    // Core answers the restore `overridden` and never calls stems; then release.
    core.release('bab');
    assert.deepEqual(applied, [{ id: 'drums', on: true, vol: 0.8 }]);
    assert.equal(m.size, 0);
});

test('through core: a release after a successful restore is a no-op', () => {
    const m = new Map();
    const applied = [];
    const core = fakeCore(m, applied);
    recordClaimMute(m, 'a', { id: 'bass', on: true, vol: 0.7 });
    // restoreStems fires claim:released inside restoreClaim: it finds nothing.
    const states = restoreClaim(m, 'a', () => core.restoreStems({ claimId: 'a' }));
    assert.deepEqual(states, [{ id: 'bass', on: true, vol: 0.7 }]);
    assert.deepEqual(applied, []);
    core.release('a');
    assert.deepEqual(applied, []);
});

// ── An automation mute is never saved; player changes survive the restore ──

test('a claimed stem is saved with the player\'s own state', () => {
    const m = new Map();
    const drums = { id: 'drums', on: true, vol: 0.8 };
    const guitar = { id: 'guitar', on: false, vol: 1 };
    recordClaimMute(m, 'a', drums);
    drums.on = false;
    assert.deepEqual(persistableStems([drums, guitar], m),
        [{ id: 'drums', on: true }, { id: 'guitar', on: false }]);
});

test('stacked claims save the same pre-claim state', () => {
    const m = new Map();
    const drums = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', drums);
    drums.on = false;
    recordClaimMute(m, 'b', drums);
    assert.deepEqual(persistableStems([drums], m), [{ id: 'drums', on: true }]);
    releaseClaim(m, 'a');
    assert.deepEqual(persistableStems([drums], m), [{ id: 'drums', on: true }]);
});

test('a player change during a claim is what the last restore gives back', () => {
    const m = new Map();
    const drums = { id: 'drums', on: true, vol: 0.8 };
    recordClaimMute(m, 'a', drums);
    recordClaimMute(m, 'b', drums);
    noteUserChange(m, 'drums', { vol: 0.5 });
    assert.deepEqual(releaseClaim(m, 'a'), []);
    assert.deepEqual(releaseClaim(m, 'b'), [{ id: 'drums', on: true, vol: 0.5 }]);

    const m2 = new Map();
    recordClaimMute(m2, 'a', drums);
    recordClaimMute(m2, 'b', drums);
    noteUserChange(m2, 'drums', { on: false });
    assert.deepEqual(releaseClaim(m2, 'a'), []);
    assert.deepEqual(releaseClaim(m2, 'b'), [{ id: 'drums', on: false, vol: 0.8 }]);
});

test('noteUserChange ignores unclaimed stems and junk', () => {
    const m = new Map();
    recordClaimMute(m, 'a', { id: 'drums', on: true, vol: 0.8 });
    const before = structuredClone(m);
    noteUserChange(m, 'bass', { on: false });
    assert.deepEqual(m, before);
    noteUserChange(m, 'drums', { on: 'x', vol: NaN });
    assert.deepEqual(m, before);
    noteUserChange(m, 'drums');
    assert.deepEqual(m, before);
});

// main.js is the entry module (importing it runs the plugin), so its wiring is
// pinned by source shape, in the style of tests/preload.test.mjs.
const MAIN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js'), 'utf8');

function fnBody(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `'${signature}' not found`);
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    return src.slice(start, i);
}

test('capRestore takes the pre-claim states before core can clear them', () => {
    const body = fnBody(MAIN, 'function capRestore(');
    const take = body.search(/restoreClaim\s*\(\s*claimSnapshots/);
    const notify = body.indexOf('restoreStems(');
    assert.ok(take !== -1, 'capRestore must read the snapshots through restoreClaim(claimSnapshots, …)');
    assert.ok(notify === -1 || notify > take,
        'session.restoreStems fires claim:released, which clears the snapshots — it must run inside/after restoreClaim');
    assert.doesNotMatch(body, /releaseClaim\s*\(\s*claimSnapshots/,
        'reading the snapshots with releaseClaim after notifying core is the bug (restoredIds: [])');
});

test('a released claim restores its stems through the same helper as capRestore', () => {
    assert.match(MAIN,
        /'claim:released':\s*\(detail\)\s*=>\s*applyRestoredStates\(releaseClaim\(claimSnapshots,/);
    assert.ok(fnBody(MAIN, 'function capRestore(').includes('applyRestoredStates('),
        'capRestore must apply its states through applyRestoredStates');
});

test('every saveMuted call saves persistableStems', () => {
    const calls = [...MAIN.matchAll(/saveMuted\(/g)];
    assert.equal(calls.length, 2);
    for (const c of calls) {
        assert.ok(MAIN.startsWith('storageSongKey(), persistableStems(S.stemState, claimSnapshots)', c.index + c[0].length),
            `saveMuted at ${c.index} must save persistableStems(S.stemState, claimSnapshots)`);
    }
});

test('player changes reach the claim snapshots', () => {
    const setVol = fnBody(MAIN, 'function setStemVolume(');
    assert.ok(setVol.includes('noteUserChange(claimSnapshots, stem.id'));
    // Inside the persist guard: drag previews and the initial render
    // (persist: false) are not player changes.
    const guard = fnBody(setVol, 'if (options.persist !== false)');
    assert.ok(guard.includes('noteUserChange(claimSnapshots, stem.id'),
        'noteUserChange must sit inside the options.persist !== false guard');
    // The drag commit saves the volume directly; it must reach the snapshots too.
    const drag = fnBody(MAIN, "if (event.type === 'pointerup') {");
    const dragNote = drag.indexOf('noteUserChange(claimSnapshots, s.id, { vol: s.vol })');
    assert.ok(dragNote !== -1, 'finishVolumeGesture must note the dragged volume');
    assert.ok(drag.includes('saveVolume(pointerFilename, s.id, s.vol)'));
    assert.ok(fnBody(MAIN, 'setMuted(id, muted) {').includes('noteUserChange(claimSnapshots, s.id'));
    const start = MAIN.indexOf('btn.onclick = (event) =>');
    assert.ok(start !== -1);
    const window600 = MAIN.slice(start, start + 600);
    const note = window600.indexOf('noteUserChange(claimSnapshots, s.id');
    const save = window600.indexOf('saveMuted(');
    assert.ok(note !== -1 && save !== -1 && note < save, 'onclick must note the change before saving');
});

// ── Real-app bug 2: another plugin un-mutes a claimed stem ─────────────────
// stem_mixer (third-party) pushes saved levels on provider-ready / song:ready
// and a 120-1800 ms bootstrap ladder: window.stems.setVolume, setMuted(false),
// then writes `on`/`gain.gain.value` straight onto stemState's live objects.
// Claims are sticky against other plugins: the stemsApi path records the
// change into the snapshots and schedules one reassert that re-mutes every
// claim-held stem that is live again. The harness mirrors main.js's wiring
// with fakes (no AudioContext, nothing audible).

function fakeStem(id, on, vol) {
    return { id, on, vol, gain: { gain: { value: on ? vol : 0 } } };
}

function harness(stems, { realMicrotasks = false } = {}) {
    const snapshots = new Map();
    const timers = [];
    const applied = [];
    const saves = [];
    // applyStemState(s, false, s.vol, { fade: true }) with no AudioContext.
    const reassertClaims = () => {
        for (const s of stemsNeedingReassert(stems, snapshots)) {
            applied.push(s.id);
            s.on = false;
            s.gain.gain.value = 0;
        }
    };
    const scheduleReassert = coalesce(
        realMicrotasks ? (fn) => queueMicrotask(fn) : (fn) => timers.push(fn), reassertClaims);
    const api = {
        setVolume(id, v) {
            for (const s of stems) {
                if (s.id !== id) continue;
                s.vol = v;
                if (s.on) s.gain.gain.value = v;
                noteUserChange(snapshots, s.id, { vol: v });
            }
            scheduleReassert();
        },
        setMuted(id, muted) {
            for (const s of stems) {
                if (s.id !== id) continue;
                s.on = !muted;
                s.gain.gain.value = s.on ? s.vol : 0;
                noteUserChange(snapshots, s.id, { on: s.on });
                saves.push(persistableStems(stems, snapshots));
            }
            scheduleReassert();
        },
    };
    const click = (s) => {            // the player's own stem button
        s.on = !s.on;
        s.gain.gain.value = s.on ? s.vol : 0;
        noteUserChange(snapshots, s.id, { on: s.on });
        markPlayerOverride(snapshots, s.id, s.on);
        saves.push(persistableStems(stems, snapshots));
    };
    const mute = (claimId, s) => {    // capMute
        recordClaimMute(snapshots, claimId, s);
        s.on = false;
        s.gain.gain.value = 0;
    };
    const flush = () => { while (timers.length) timers.shift()(); };
    return { snapshots, timers, applied, saves, api, click, mute, flush };
}

function stemMixerPush(api, stems, id, v) {
    api.setVolume(id, v);
    api.setMuted(id, false);
    const item = stems.find(s => s.id === id);
    item.on = true;
    item.gain.gain.value = v;
}

test('a claimed stem stays muted through a stem_mixer push and restores at its volume', () => {
    const drums = fakeStem('drums', true, 0.8);
    const h = harness([drums]);
    h.mute('rockherosmith:sound:drums', drums);
    stemMixerPush(h.api, [drums], 'drums', 0.6);
    assert.equal(drums.on, true, 'the mixer wrote it on synchronously');
    h.flush();
    assert.equal(drums.on, false);
    assert.equal(drums.gain.gain.value, 0);
    assert.deepEqual(h.saves.at(-1), [{ id: 'drums', on: true }], 'never saved as muted');
    assert.deepEqual(releaseClaim(h.snapshots, 'rockherosmith:sound:drums'),
        [{ id: 'drums', on: true, vol: 0.6 }]);
});

test('repeated schedules coalesce into one reassert pass', () => {
    const drums = fakeStem('drums', true, 0.8);
    const h = harness([drums]);
    h.mute('a', drums);
    stemMixerPush(h.api, [drums], 'drums', 0.6);
    stemMixerPush(h.api, [drums], 'drums', 0.5);
    assert.equal(h.timers.length, 1);
    h.flush();
    assert.deepEqual(h.applied, ['drums']);
    stemMixerPush(h.api, [drums], 'drums', 0.4);
    assert.equal(h.timers.length, 1, 'a new schedule after the pass ran');
});

test('an unclaimed stem is unaffected by the reassert', () => {
    const drums = fakeStem('drums', true, 0.8);
    const bass = fakeStem('bass', false, 0.7);
    const h = harness([drums, bass]);
    h.mute('a', drums);
    stemMixerPush(h.api, [drums, bass], 'bass', 0.9);
    stemMixerPush(h.api, [drums, bass], 'drums', 0.6);
    h.flush();
    assert.deepEqual(h.applied, ['drums']);
    assert.equal(bass.on, true);
    assert.equal(bass.gain.gain.value, 0.9);
    assert.equal(h.snapshots.size, 1, 'the reassert never touches the snapshots');
});

test('the player\'s button click on a claimed stem unmutes it with no reassert', () => {
    const drums = fakeStem('drums', true, 0.8);
    const h = harness([drums]);
    h.mute('a', drums);
    h.click(drums);
    assert.equal(h.timers.length, 0);
    h.flush();
    assert.equal(drums.on, true);
    assert.equal(drums.gain.gain.value, 0.8);
});

test('stemsNeedingReassert picks claim-held stems that are on or have gain', () => {
    const m = new Map();
    const a = fakeStem('a', false, 0.8);
    const b = fakeStem('b', false, 0.8);
    const c = fakeStem('c', true, 0.8);
    const d = fakeStem('d', false, 0.8);
    for (const s of [a, b, d]) recordClaimMute(m, 'x', s);
    b.gain.gain.value = 0.3;            // muted flag but live gain
    d.on = true; d.gain = null;          // no graph yet: on alone counts
    assert.deepEqual(stemsNeedingReassert([a, b, c, d], m).map(s => s.id), ['b', 'd']);
});

test('main.js: stemsApi schedules the reassert; the stem button does not', () => {
    for (const sig of ['setVolume(id, vol) {', 'setMuted(id, muted) {']) {
        assert.ok(fnBody(MAIN, sig).includes('scheduleClaimReassert()'), `${sig} must schedule a reassert`);
    }
    const start = MAIN.indexOf('btn.onclick = (event) =>');
    assert.doesNotMatch(fnBody(MAIN.slice(start), 'btn.onclick = (event) =>'), /scheduleClaimReassert/);
    assert.match(MAIN, /const scheduleClaimReassert = coalesce\(\s*\(fn\) => queueMicrotask\(fn\),\s*reassertClaims\s*\)/);
    assert.doesNotMatch(MAIN, /scheduleClaimReassert = coalesce\([^;]*setTimeout/);
    const body = fnBody(MAIN, 'function reassertClaims(');
    assert.match(body, /stemsNeedingReassert\(S\.stemState, claimSnapshots\)/);
    assert.match(body, /applyStemState\(s, false, s\.vol, \{ fade: true \}\)/);
    assert.doesNotMatch(body, /save|noteUserChange|recordClaimMute|releaseClaim|clearClaim/);
});

// ── Follow-up: microtask reassert; the player's button override sticks ─────

test('the reassert runs in a microtask, after the caller\'s synchronous writes', async () => {
    const drums = fakeStem('drums', true, 0.8);
    const h = harness([drums], { realMicrotasks: true });
    h.mute('a', drums);
    stemMixerPush(h.api, [drums], 'drums', 0.6);
    assert.equal(drums.on, true, 'not before the caller\'s writes finish');
    await Promise.resolve();
    assert.equal(drums.on, false);
    assert.equal(drums.gain.gain.value, 0);
    assert.deepEqual(h.applied, ['drums'], 'coalesced into one pass');
});

test('the player clicks a claimed stem on: a stem_mixer push does not re-mute it', () => {
    const drums = fakeStem('drums', true, 0.8);
    const h = harness([drums]);
    h.mute('a', drums);
    h.mute('b', drums);
    h.click(drums);
    assert.ok(Array.from(h.snapshots.values()).every(e => e.playerOverride === true),
        'every claim holding the stem is marked');
    h.api.setVolume('drums', 0.6);
    h.api.setMuted('drums', false);
    h.flush();
    assert.deepEqual(h.applied, []);
    assert.equal(drums.on, true);
    assert.equal(drums.gain.gain.value, 0.6);
});

test('muting again with the button clears the override; release drops it', () => {
    const drums = fakeStem('drums', true, 0.8);
    const h = harness([drums]);
    h.mute('a', drums);
    h.click(drums);                    // on: overridden
    h.click(drums);                    // off again: override cleared
    assert.ok(Array.from(h.snapshots.values()).every(e => !e.playerOverride));
    stemMixerPush(h.api, [drums], 'drums', 0.6);
    h.flush();
    assert.deepEqual(h.applied, ['drums']);
    h.click(drums);
    releaseClaim(h.snapshots, 'a');
    assert.equal(h.snapshots.size, 0);
    h.mute('c', drums);                // a fresh claim starts unflagged
    assert.equal(h.snapshots.get('c:drums').playerOverride, undefined);
});

test('a claim made after the override still reasserts; markPlayerOverride ignores unclaimed ids', () => {
    const m = new Map();
    const drums = fakeStem('drums', false, 0.8);
    recordClaimMute(m, 'a', drums);
    markPlayerOverride(m, 'drums', true);
    drums.on = true;
    assert.deepEqual(stemsNeedingReassert([drums], m), []);
    recordClaimMute(m, 'b', drums);    // newer claim: not overridden
    assert.deepEqual(stemsNeedingReassert([drums], m).map(s => s.id), ['drums']);
    const before = structuredClone(m);
    markPlayerOverride(m, 'bass', true);
    assert.deepEqual(m, before);
});

test('main.js: the stem button marks the override after noting the change', () => {
    const start = MAIN.indexOf('btn.onclick = (event) =>');
    const body = fnBody(MAIN.slice(start), 'btn.onclick = (event) =>');
    const note = body.indexOf('noteUserChange(claimSnapshots, s.id, { on: s.on })');
    const mark = body.indexOf('markPlayerOverride(claimSnapshots, s.id, s.on)');
    assert.ok(note !== -1 && mark > note, 'onclick must mark the player override after noteUserChange');
    assert.doesNotMatch(fnBody(MAIN, 'setMuted(id, muted) {'), /markPlayerOverride/);
    assert.doesNotMatch(fnBody(MAIN, 'setVolume(id, vol) {'), /markPlayerOverride/);
});

test('a claim mute, restore or reassert refreshes aria-pressed and the label', () => {
    const body = fnBody(MAIN, 'function applyStemState(');
    assert.ok(body.includes('updateStemButton(stem)'));
    assert.ok(!body.includes('stem.btn.className'));
});

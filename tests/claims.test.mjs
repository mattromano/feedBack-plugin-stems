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
    persistableStems, noteUserChange,
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

function fakeCore(snapshots) {
    // Stems' participant `claim:released` handler, as wired in main.js.
    const onClaimReleased = (detail) => clearClaim(snapshots, detail && detail.payload && detail.payload.claimId);
    return {
        restoreStems({ claimId }) { onClaimReleased({ payload: { claimId } }); },
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

test('the claim:released handler clears through clearClaim', () => {
    assert.match(MAIN, /'claim:released':\s*\(detail\)\s*=>\s*clearClaim\(claimSnapshots,/);
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
    assert.ok(fnBody(MAIN, 'function setStemVolume(').includes('noteUserChange(claimSnapshots, stem.id'));
    assert.ok(fnBody(MAIN, 'setMuted(id, muted) {').includes('noteUserChange(claimSnapshots, s.id'));
    const start = MAIN.indexOf('btn.onclick = (event) =>');
    assert.ok(start !== -1);
    const window600 = MAIN.slice(start, start + 600);
    const note = window600.indexOf('noteUserChange(claimSnapshots, s.id');
    const save = window600.indexOf('saveMuted(');
    assert.ok(note !== -1 && save !== -1 && note < save, 'onclick must note the change before saving');
});

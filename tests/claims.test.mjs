// Unit tests for src/claims.js — pure claim-snapshot stacking and the
// automation fade. Real ES-module import; the gain param is a recording fake
// (no AudioContext, nothing audible).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLAIM_FADE_TC_S, recordClaimMute, releaseClaim, fadeGain } from '../src/claims.js';

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

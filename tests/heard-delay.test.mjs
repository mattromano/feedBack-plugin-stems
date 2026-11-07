// transportPlayhead() follows the song as HEARD: it drops the output delay the
// desktop host measures for this AudioContext (window.__fbSongOutputDelay —
// the engine song bus's heard frame, or the context's output timestamp), on
// top of the WSOLA latency. Real module import; a fake AudioContext clock.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
const { transportPlayhead } = await import('../src/transport.js');
const { S, transport } = await import('../src/state.js');

const ctx = { currentTime: 100 };
function playingAt(ctxTime, { rate = 1, base = 10, baseCtx = 90 } = {}) {
    S.audioCtx = ctx;
    S.useWorklet = false;
    S.latencyOffsetSec = 0;
    ctx.currentTime = ctxTime;
    transport.playing = true;
    transport.rate = rate;
    transport.baseOffset = base;
    transport.baseCtxTime = baseCtx;
    transport.duration = 600;
}
const delay = (sec, extra = {}) => { window.__fbSongOutputDelay = { ctx, sec, source: 'song-bus', at: performance.now(), ...extra }; };

test('no measurement: the raw context clock (browser host / before the first sample)', () => {
    playingAt(100);
    window.__fbSongOutputDelay = null;
    assert.equal(transportPlayhead(), 20);
});

test('a measured delay is subtracted while playing', () => {
    playingAt(100);
    delay(0.058);
    assert.ok(Math.abs(transportPlayhead() - (20 - 0.058)) < 1e-9);
});

test('practice speed: the delay is context time, so it scales with the rate', () => {
    playingAt(100, { rate: 0.5 });
    delay(0.060);
    // 10 s of context at 0.5x = 5 s of song, minus 60 ms of context = 30 ms of song.
    assert.ok(Math.abs(transportPlayhead() - (10 + 5 - 0.030)) < 1e-9);
});

test('stacks with the WSOLA latency', () => {
    playingAt(100, { rate: 0.8 });
    S.useWorklet = true;
    S.latencyOffsetSec = 0.02;
    delay(0.05);
    assert.ok(Math.abs(transportPlayhead() - (10 + 8 - 0.02 - 0.04)) < 1e-9);
});

test('another context\'s figure (a previous song) is never applied', () => {
    playingAt(100);
    delay(0.058, { ctx: {} });
    assert.equal(transportPlayhead(), 20);
});

test('a stale figure (> 2 s old) is ignored', () => {
    playingAt(100);
    delay(0.058, { at: performance.now() - 5000 });
    assert.equal(transportPlayhead(), 20);
});

test('nonsense values are ignored', () => {
    for (const sec of [NaN, -0.01, 0, 1.5, Infinity]) {
        playingAt(100);
        delay(sec);
        assert.equal(transportPlayhead(), 20, String(sec));
    }
});

test('paused: the held position, untouched', () => {
    playingAt(100);
    delay(0.058);
    transport.playing = false;
    assert.equal(transportPlayhead(), 10);
});

// transportPlayhead() follows the song as HEARD: it drops the output delay the
// desktop host measures for this AudioContext (window.__fbSongOutputDelay —
// the engine song bus's heard frame, or the context's output timestamp), on
// top of the WSOLA latency. Real module import; a fake AudioContext clock.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };   // dispatchAudioEvent: no #audio
const { transportPlayhead, transportPlay, transportSeek, setTransportRate, onWorkletMessage } = await import('../src/transport.js');
const { S, ST, transport } = await import('../src/state.js');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} got ${a}, want ${b}`);

// A fresh context per scenario: the held delay belongs to one context.
let ctx = null;
function playingAt(ctxTime, { rate = 1, base = 10, baseCtx = 90 } = {}) {
    ctx = { currentTime: 100 };
    S.audioCtx = ctx;
    S.useWorklet = false;
    S.latencyOffsetSec = 0;
    ctx.currentTime = ctxTime;
    transport.playing = true;
    transport.rate = rate;
    transport.baseOffset = base;
    transport.baseCtxTime = baseCtx;
    transport.duration = 600;
    transport.anchor = null;
    S.stemState = [];
    S.workletNode = { port: { postMessage() {} } };
    S.workletLatencyOutSamples = 0;
    ST.streaming = false;
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

test('the last good figure is held while the host re-measures (cleared / stale / skipped)', () => {
    playingAt(100);
    delay(0.058);
    assert.ok(Math.abs(transportPlayhead() - (20 - 0.058)) < 1e-9);
    // Host cleared it (song bus engaged): no forward step by the whole delay.
    window.__fbSongOutputDelay = null;
    assert.ok(Math.abs(transportPlayhead() - (20 - 0.058)) < 1e-9);
    // An old figure of the same context still counts.
    delay(0.060, { at: performance.now() - 60000 });
    assert.ok(Math.abs(transportPlayhead() - (20 - 0.060)) < 1e-9);
    // Nonsense in the gap doesn't replace it either.
    delay(NaN);
    assert.ok(Math.abs(transportPlayhead() - (20 - 0.060)) < 1e-9);
});

test('a new context drops the held figure', () => {
    playingAt(100);
    delay(0.058);
    transportPlayhead();
    playingAt(100);                         // next song: a new AudioContext
    window.__fbSongOutputDelay = null;
    assert.equal(transportPlayhead(), 20);
});

test('nonsense values are ignored (0 is a valid zero delay)', () => {
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

// ── Discontinuities: the delay is context time, taken off before the rate ──

test('seek while playing reads back as its target (core setLoop landed-check) and holds until heard', () => {
    playingAt(100);
    S.useWorklet = true;
    delay(0.15);
    transportSeek(50);
    assert.equal(transportPlayhead(), 50);          // |to - A| = 0 < 50 ms
    ctx.currentTime = 100.1;                        // old audio still in the pipeline
    assert.equal(transportPlayhead(), 50);
    ctx.currentTime = 100.25;                       // 100 ms after the target is heard
    near(transportPlayhead(), 50.1);
});

test('play from pause starts at the paused position, no jump back by the delay', () => {
    playingAt(100);
    S.useWorklet = true;
    S.buffersReady = true;
    S.pendingPlayResolvers = [];
    delay(0.15);
    transport.playing = false;
    transport.baseOffset = 42;
    transportPlay();
    assert.equal(transport.playing, true);
    assert.equal(transportPlayhead(), 42);
    ctx.currentTime = 100.15;
    assert.equal(transportPlayhead(), 42);
    ctx.currentTime = 100.4;
    near(transportPlayhead(), 42.25);
});

test('rate change: the in-flight audio keeps the old rate, no rescale jump', () => {
    playingAt(100);                                 // 1.0x, frontier 20 at ctx 100
    delay(0.15);
    near(transportPlayhead(), 19.85);
    setTransportRate(0.5);
    near(transportPlayhead(), 19.85, 'continuous at the change');   // was 19.925
    ctx.currentTime = 100.1;
    near(transportPlayhead(), 19.95, 'still the 1.0x audio');
    ctx.currentTime = 100.15;
    near(transportPlayhead(), 20, 'the change is heard');
    ctx.currentTime = 100.35;
    near(transportPlayhead(), 20.1, 'then 0.5x');
});

test('rate change at practice speed with WSOLA: continuous across the change', () => {
    playingAt(100, { rate: 0.8 });                  // frontier 18
    S.useWorklet = true;
    S.audioCtx.sampleRate = 48000;
    S.workletLatencyOutSamples = 768;
    S.latencyOffsetSec = 768 / 48000 * (0.8 - 1);
    delay(0.1);
    const before = transportPlayhead();
    setTransportRate(1.25);
    near(transportPlayhead(), before);
    ctx.currentTime = 100.5;                        // heard at 100.4: 0.4 s at 1.25x
    near(transportPlayhead(), 18 + 0.4 * 1.25 - 768 / 48000 * 0.25);
});

test('streaming pos re-baselines keep the heard clock running', () => {
    playingAt(100);
    S.useWorklet = true;
    ST.streaming = true;
    ST.streamSampleRate = 48000;
    delay(0.15);
    for (let i = 0; i <= 10; i++) {
        ctx.currentTime = 100 + i * 0.02;
        onWorkletMessage({ data: { type: 'pos', pos: Math.round((20 + i * 0.02) * 48000) } });
        near(transportPlayhead(), 20 + i * 0.02 - 0.15, `tick ${i}`);
    }
    ST.streaming = false;
});

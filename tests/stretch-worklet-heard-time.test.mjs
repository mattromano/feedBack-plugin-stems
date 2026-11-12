// The WSOLA worklet at practice speeds: where is each moment of the song
// actually HEARD, against what the transport claims (frontier clock minus
// S.latencyOffsetSec from updateLatencyOffset)? A click train goes through the
// real worklet; each click's energy centroid in the output must land where the
// claimed playhead says that song position is. The old offset (L * rate) put
// it 16 ms off at every rate; L * (rate - 1) is the true one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let REG = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, _sink: null, postMessage(m) { if (this._sink) this._sink(m); } }; }
};
globalThis.registerProcessor = (n, c) => { REG = c; };
eval(fs.readFileSync(path.join(__dirname, '..', 'assets', 'stretch-worklet.js'), 'utf8').replace(/^'use strict';/m, ''));
globalThis.window = globalThis;
const { updateLatencyOffset } = await import('../src/audio-ctx.js');
const { S, transport } = await import('../src/state.js');

const SR = 48000, SECS = 10;
const src = new Float32Array(SR * SECS);
const clicks = [];
for (let t = 0.5; t < SECS - 0.5; t += 0.37) {
    const s = Math.round(t * SR);
    clicks.push(s);
    for (let i = 0; i < 480; i++) src[s + i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR) * Math.sin(Math.PI * i / 480);
}
const centroid = (b, lo, hi) => { let w = 0, m = 0; for (let i = lo; i < hi; i++) { const e = b[i] * b[i]; w += e; m += e * i; } return m / w; };

function heardErrorsMs(rate) {
    const p = new REG();
    let L = 0;
    p.port._sink = (m) => { if (m.type === 'ready') L = m.latencyOutSamples; };
    p.port.onmessage({ data: { type: 'load', stems: [{ channels: [src.slice()], length: src.length }], gains: [1] } });
    p.port.onmessage({ data: { type: 'start', offset: 0, rate } });
    const nq = Math.ceil((SECS / rate) * SR / 128);
    const out = new Float32Array(nq * 128);
    for (let q = 0; q < nq; q++) { const a = new Float32Array(128), b = new Float32Array(128); p.process([], [[a, b]]); out.set(a, q * 128); }
    // The transport's claim: song time heard at output sample n is
    // n * rate / SR - S.latencyOffsetSec.
    S.useWorklet = true; S.audioCtx = { sampleRate: SR }; S.workletLatencyOutSamples = L || p.latencyOutSamples;
    transport.rate = rate;
    updateLatencyOffset();
    const errs = [];
    for (const s of clicks) {
        const songSec = centroid(src, s, s + 480) / SR;
        const n = (songSec + S.latencyOffsetSec) * SR / rate;     // where the claim puts it
        const lo = Math.floor(n - 2400), hi = Math.floor(n + 2400);
        if (lo < 0 || hi > out.length) continue;
        errs.push((centroid(out, lo, hi) - n) / SR * 1000 * rate);  // ms of song time
    }
    return errs.sort((a, b) => a - b);
}

for (const rate of [0.5, 0.65, 0.75, 0.9, 1.1, 1.25, 1.5]) {
    test(`at ${rate}x the playhead names the song moment being heard (within 3 ms)`, () => {
        const e = heardErrorsMs(rate);
        assert.ok(e.length >= 15);
        const med = e[e.length >> 1];
        assert.ok(Math.abs(med) < 3, `median ${med.toFixed(2)} ms`);
    });
}

test('1.0x is an exact pass-through: no offset at all', () => {
    S.useWorklet = true; S.audioCtx = { sampleRate: SR }; S.workletLatencyOutSamples = 768;
    transport.rate = 1;
    updateLatencyOffset();
    assert.equal(S.latencyOffsetSec, 0);
});

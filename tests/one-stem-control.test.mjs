// feedBack-desktop#19: stem volume in ONE place — the core Mixer. The plugin's own player-bar
// row is off (saved volumes still applied), and the core fader carries mute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js'), 'utf8');

test('the player-bar stem row is off, but saved stem volumes are still applied', () => {
    assert.match(SRC, /const SHOW_PLAYER_STEM_BAR = false;/);
    assert.match(SRC, /if \(!SHOW_PLAYER_STEM_BAR\) \{\s*\/\/[^\n]*\n\s*for \(const s of S\.stemState\) setStemVolume\(s, s\.vol, \{ persist: false \}\);\s*return;/);
});

test('every stem is still a core Mixer fader, and the fader carries mute', () => {
    assert.match(SRC, /function registerStemMixParticipant\(stem\)/);
    assert.match(SRC, /'fader\.get-value': \(\) => \(stem\.on \? stem\.vol : 0\)/);
    assert.match(SRC, /if \(Number\(value\) > 0 && !stem\.on\) stemsApi\.setMuted\(stem\.id, false\);/);
    assert.match(SRC, /currentValue: stem\.on \? stem\.vol : 0/);
});

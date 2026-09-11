// Original Agent Studio two-note bell; deterministic, no external samples.
// Run from the repository root. PCM16 mono, 44.1 kHz, 0.92 seconds.
import { mkdirSync, writeFileSync } from 'node:fs';
const rate = 44100,
  count = Math.round(rate * 0.92);
const wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(count * 2, 40);
for (let i = 0; i < count; i++) {
  const time = i / rate;
  let sample = 0;
  for (const [start, frequency] of [
    [0, 659.255],
    [0.18, 987.767],
  ]) {
    const t = time - start;
    if (t < 0) continue;
    const envelope = Math.min(t / 0.009, 1) * Math.exp(-t * 7) * Math.min((0.92 - time) / 0.06, 1);
    sample +=
      0.27 *
      envelope *
      (Math.sin(2 * Math.PI * frequency * t) + 0.18 * Math.sin(4 * Math.PI * frequency * t));
  }
  wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
}
mkdirSync('src-tauri/sounds', { recursive: true });
writeFileSync('src-tauri/sounds/agent-chime.wav', wav);

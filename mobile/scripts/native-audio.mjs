import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Original, deterministic two-tone radio acknowledgement. No third-party audio.
const sampleRate = 24000;
const count = Math.round(sampleRate * 0.48);
const wav = Buffer.alloc(44 + count * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + count * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(count * 2, 40);
for (let i = 0; i < count; i += 1) {
  const t = i / sampleRate;
  const active = (t < 0.12) || (t > 0.18 && t < 0.34);
  const local = t < 0.12 ? t : t - 0.18;
  const duration = t < 0.12 ? 0.12 : 0.16;
  const envelope = active ? Math.min(1, local / 0.008, (duration - local) / 0.024) : 0;
  const hz = t < 0.12 ? 1060 : 820;
  const signal = (Math.sin(2 * Math.PI * hz * t) + 0.16 * Math.sin(2 * Math.PI * hz * 2 * t)) * envelope * 0.24;
  wav.writeInt16LE(Math.round(signal * 32767), 44 + i * 2);
}
const directory = new URL('../android/app/src/main/res/raw/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('radio_chirp.wav', directory), wav);
console.log(`Notification sound ready: ${fileURLToPath(directory)}radio_chirp.wav`);

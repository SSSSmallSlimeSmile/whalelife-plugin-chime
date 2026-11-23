/*! 生成插件自带的提示音。
 *
 * 为什么现生成而不是从别处拷：仓库要公开，音频一旦带上别人的版权，
 * 后续每个用户下载都在替我们承担风险。这里全部用正弦波加指数包络合成，
 * 没有采样、没有素材来源，随仓库一起按 MIT 发布。
 *
 * 跑法：node tools/make-sounds.mjs
 * 产物：sounds/chime-01.wav … chime-04.wav（44.1kHz 单声道 16bit）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "sounds");
const RATE = 44100;

/** 一个衰减的正弦音。freq 频率、start 起始秒、len 持续秒、amp 振幅。 */
function tone(freq, start, len, amp) {
  const out = new Float64Array(Math.ceil(len * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    // 攻击 8ms 淡入，之后指数衰减：避免爆音，也不至于拖尾。
    const attack = Math.min(1, t / 0.008);
    const decay = Math.exp(-3.2 * (t / len));
    out[i] = Math.sin(2 * Math.PI * freq * t) * amp * attack * decay;
  }
  return { at: Math.round(start * RATE), data: out };
}

/** 把若干音叠加进一条总轨。 */
function mix(parts, total) {
  const buf = new Float64Array(Math.ceil(total * RATE));
  for (const { at, data } of parts) {
    for (let i = 0; i < data.length; i++) {
      const j = at + i;
      if (j < buf.length) buf[j] += data[i];
    }
  }
  return buf;
}

/** 写 16bit 单声道 WAV。 */
function wav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // 单声道
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  // 归一到 0.72，留 3dB 余量，避免某些设备上削顶。
  const gain = peak > 0 ? 0.72 / peak : 1;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * gain));
    bytes.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return bytes;
}

const SOUNDS = {
  // 两音上行，最像“好了”的那种提示
  "chime-01.wav": () => mix([tone(880, 0, 0.42, 1), tone(1318.5, 0.11, 0.5, 0.8)], 0.75),
  // 三音上行，更亮一点
  "chime-02.wav": () =>
    mix([tone(784, 0, 0.3, 1), tone(1046.5, 0.09, 0.3, 0.85), tone(1568, 0.18, 0.45, 0.7)], 0.8),
  // 单音轻响，短，适合频繁触发
  "chime-03.wav": () => mix([tone(1046.5, 0, 0.55, 1), tone(2093, 0, 0.25, 0.25)], 0.65),
  // 下行两音，用来区分“失败”之类
  "chime-04.wav": () => mix([tone(987.8, 0, 0.35, 1), tone(659.3, 0.12, 0.5, 0.85)], 0.75),
};

mkdirSync(OUT, { recursive: true });
for (const [name, build] of Object.entries(SOUNDS)) {
  const bytes = wav(build());
  writeFileSync(join(OUT, name), bytes);
  console.log(`${name}  ${bytes.length} 字节  ${((bytes.length - 44) / 2 / RATE).toFixed(2)}s`);
}

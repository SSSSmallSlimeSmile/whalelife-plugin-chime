/*! WhaleLife「提示音」插件：一轮任务真跑完、回复落地之后，在宿主电脑响一声。
 *
 * 判据：从「用户这句话落盘」算起，到「回复真的发出去」为止，超过 min_seconds
 * 才响——随口一问不滴滴叫。
 *
 * 三条老坑，写在前面，改之前先看一眼：
 * 1. 只认「回复真的发出去」，不认「agent 跑完」——子代理跑完也会宣告结束，
 *    照那个响，你发一句能听两三次。
 * 2. 冷却和占用放在模块级 + 一个临时文件里。插件重载后老实例还挂在事件链上，
 *    两边各自计时就会两声叠一起，后一声把前一声掐断。
 * 3. 用另一个进程放音。同一个进程里两次 winsound 会抢同一个独占通道。
 *
 * 平台：只在 Windows 上出声（SoundPlayer / WPF MediaPlayer）。别的系统上
 * 插件照常加载，chime_test 会明说「这台机器不出声」，不报错也不假装。
 */
import type { Context } from "../../core/context.ts";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === "win32";

const DEFAULTS = {
  enabled: true,
  /** 兜底音效：sound_path 没填或读不到时用它。 */
  wav_path: join(HERE, "sounds", "chime-01.wav"),
  /** 音效文件或目录。wav 走 SoundPlayer，mp3 走 WPF MediaPlayer。填目录则每次随机抽一个。 */
  sound_path: join(HERE, "sounds"),
  /** 少于这么多秒的回合不响。 */
  min_seconds: 8,
  cooldown_seconds: 3,
  /** 只在这些通道响；空数组表示全响。例：["web"] */
  channels: [] as string[],
  log: join(HERE, "data", "chime.log"),
};

type Config = typeof DEFAULTS;

// 模块级：活得比任何一个实例都长。跨进程重启靠文件里那道闸。
const GUARD_PATH = join(tmpdir(), "whalelife_chime.guard");
let LAST_PLAY = 0;
let BUSY_UNTIL = 0;

function guardLeft(): number {
  try {
    const until = Number(readFileSync(GUARD_PATH, "utf8").trim() || 0);
    return until - Date.now() / 1000;
  } catch {
    return -1;
  }
}

function guardSet(seconds: number): void {
  try {
    writeFileSync(GUARD_PATH, (Date.now() / 1000 + seconds).toFixed(3), "utf8");
  } catch {
    /* 闸写不进去就少一道保险，不该因此不响 */
  }
}

const prepared = new Set<string>();

function trace(file: string, line: string): void {
  if (!file) return;
  try {
    // data/ 不随包发布，全新安装时这个目录不存在；不建的话日志会静默写不进去。
    const dir = dirname(file);
    if (!prepared.has(dir)) {
      mkdirSync(dir, { recursive: true });
      prepared.add(dir);
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志是证据，不是命门 */
  }
}

/** 读音频时长：wav 看头，mp3 按比特率估算。读不出来按一秒半算。 */
function audioSeconds(path: string, fallback = 1.5): number {
  try {
    const buf = readFileSync(path);
    if (buf.length >= 44 && buf.toString("ascii", 0, 4) === "RIFF") {
      let at = 12;
      let byteRate = 0;
      while (at + 8 <= buf.length) {
        const id = buf.toString("ascii", at, at + 4);
        const size = buf.readUInt32LE(at + 4);
        if (id === "fmt " && at + 16 <= buf.length) byteRate = buf.readUInt32LE(at + 16);
        if (id === "data" && byteRate > 0) return size / byteRate;
        at += 8 + size + (size % 2);
      }
    }
    // mp3：跳过 ID3v2，找到第一个帧头，按比特率估总时长。VBR 会有偏差，够用。
    let at = 0;
    if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
      const size =
        ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      at = 10 + size;
    }
    // MPEG1 与 MPEG2/2.5 的比特率表不同，别只认前者。
    const RATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const RATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let guard = 0;
    while (at + 4 <= buf.length && guard++ < 200000) {
      if (buf[at] === 0xff && (buf[at + 1] & 0xe0) === 0xe0) {
        const ver = (buf[at + 1] >> 3) & 3;
        const brIdx = (buf[at + 2] >> 4) & 0x0f;
        if (ver !== 1 && brIdx > 0 && brIdx < 15) {
          const table = ver === 3 ? RATES_V1 : RATES_V2;
          return (buf.length - at) / ((table[brIdx] * 1000) / 8);
        }
        break;
      }
      at++;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 挑这一声用哪个文件。sound_path 是目录时随机抽一个，是文件时就用它。 */
function pickSound(cfg: Config): { path: string; seconds: number } {
  const raw = String(cfg.sound_path || cfg.wav_path || "");
  if (!raw || !existsSync(raw)) return { path: raw, seconds: 1.5 };
  try {
    if (statSync(raw).isDirectory()) {
      const files = readdirSync(raw).filter((f) => /\.(wav|mp3)$/i.test(f));
      if (files.length) {
        const one = join(raw, files[Math.floor(Math.random() * files.length)]);
        return { path: one, seconds: audioSeconds(one) };
      }
    }
  } catch {
    /* 目录读不动就当文件处理，不该因此不响 */
  }
  return { path: raw, seconds: audioSeconds(raw) };
}

/** 单引号字符串转义：PowerShell 里连续两个单引号表示一个字面单引号。 */
const psQuote = (text: string) => text.replace(/'/g, "''");

/** 另起一个进程去放。返回是否确实发出去了。 */
function play(path: string): boolean {
  if (!WINDOWS) return false;
  const ok = Boolean(path) && existsSync(path);
  const q = psQuote(path);
  const script = !ok
    ? "[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800"
    : /\.mp3$/i.test(path)
      // mp3: SoundPlayer 只认 wav，得用 WPF 的 MediaPlayer。等它真正播完再收，别硬切。
      ? `Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${q}'); $p.Play(); Start-Sleep -Milliseconds ${Math.ceil((audioSeconds(path) + 0.4) * 1000)}; $p.Close()`
      : `(New-Object System.Media.SoundPlayer '${q}').PlaySync()`;
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, stdio: "ignore" },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function apply(ctx: Context) {
  if (!WINDOWS) ctx.logger.warn(`提示音：当前系统是 ${process.platform}，只有 Windows 能出声，插件其余部分照常`);

  let saved: Partial<Config> | null = null;
  try {
    saved = await ctx.config.read<Partial<Config>>("config.json");
  } catch {
    saved = null;
  }
  let cfg: Config = { ...DEFAULTS, ...(saved ?? {}) };
  let { path: wav, seconds: duration } = pickSound(cfg);

  /** 每次要判断前重读一遍，页面里改完立刻生效。 */
  const reload = async () => {
    try {
      const again = await ctx.config.read<Partial<Config>>("config.json");
      cfg = { ...DEFAULTS, ...(again ?? {}) };
    } catch {
      // 读不到就沿用旧值，不该因此不响
    }
    ({ path: wav, seconds: duration } = pickSound(cfg));
  };
  if (wav && !existsSync(wav)) ctx.logger.warn(`音效文件不存在，回退系统提示音：${wav}`);

  const starts = new Map<string, number>();
  const sessionOf = (event: any) => String(event?.session ?? event?.channel ?? "?");
  const allowed = (event: any) =>
    !cfg.channels.length || cfg.channels.includes(String(event?.channel ?? ""));

  // 用户那句话落地 = 这一轮开始
  ctx.on("channel/message", (event) => {
    if (event?.role !== "user" || !allowed(event)) return;
    const now = Date.now();
    starts.set(sessionOf(event), now);
    if (starts.size > 256) {
      for (const [key, at] of starts) if (now - at > 15 * 60_000) starts.delete(key);
    }
  });

  // 回复落地 = 这一轮真的发出去了
  ctx.on("channel/reply", async (event) => {
    await reload();
    if (!cfg.enabled || !event || event.transient === true || !allowed(event)) return;
    const key = sessionOf(event);
    const began = starts.get(key);
    if (began === undefined) return;
    starts.delete(key);

    const elapsed = (Date.now() - began) / 1000;
    if (elapsed < Number(cfg.min_seconds)) return;

    const now = Date.now() / 1000;
    if (now - LAST_PLAY < Number(cfg.cooldown_seconds)) return;
    if (now < BUSY_UNTIL) return;
    const left = guardLeft();
    if (left > 0) {
      trace(cfg.log, `skip guard_left=${left.toFixed(2)}s`);
      return;
    }
    if (!play(wav)) {
      trace(cfg.log, "error spawn-failed");
      ctx.logger.warn(WINDOWS ? "提示音播放失败：起不了 powershell" : "提示音播放失败：当前系统不出声");
      return;
    }
    LAST_PLAY = now;
    BUSY_UNTIL = now + duration + 0.05;
    guardSet(duration + 0.05);
    trace(cfg.log, `play dur=${duration.toFixed(2)}s elapsed=${elapsed.toFixed(1)}s`);
    ctx.logger.info(`提示音已响，本轮 ${elapsed.toFixed(1)}s`);
  });

  ctx.tools.register({
    name: "chime_test",
    description: "立刻在宿主电脑上放一次提示音，用来确认声音通道是否还通。不参与回合判定。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      await reload();
      const ok = play(wav);
      trace(cfg.log, `test ok=${ok}`);
      if (ok) return "已发出提示音";
      return WINDOWS ? "播放失败：起不了 powershell" : `播放失败：${process.platform} 上不出声，只有 Windows 支持`;
    },
  });

  ctx.web.api("/plugins/chime/test", async (_req: any, res: any) => {
    const reply = (code: number, body: any) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      await reload();
      const ok = play(wav);
      trace(cfg.log, `test ok=${ok}`);
      if (!ok)
        return reply(500, {
          ok: false,
          error: WINDOWS ? "起不了 powershell，声音没发出去" : `${process.platform} 上不出声，只有 Windows 支持`,
        });
      return reply(200, { ok: true, detail: `已发出：${wav || "系统提示音"}` });
    } catch (error: any) {
      return reply(500, { ok: false, error: error?.message ?? String(error) });
    }
  });

  ctx.web.page(
    "/plugins/chime/",
    async (_req: any, res: any) => {
      await reload();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage(cfg));
    },
    { title: "提示音", navigation: true },
  );

  ctx.web.api("/plugins/chime/save", async (req: any, res: any) => {
    try {
      const patchIn = sanitize(await readBody(req));
      const keys = Object.keys(patchIn);
      if (!keys.length) throw new Error("没有可保存的字段");
      const merged = { ...(await ctx.config.read<any>("config.json").catch(() => null)), ...patchIn };
      await ctx.config.save("config.json", merged);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, saved: keys }));
    } catch (error: any) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
    }
  });
}

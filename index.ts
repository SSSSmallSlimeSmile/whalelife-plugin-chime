/*! WhaleLife「提示音」插件：一轮任务跑完、回复落盘之后，在宿主电脑响一声。
 *
 * 触发点是 channel/reply —— 回复已经存下来了，不是「模型答完」，也不是
 * 「消息送到对方手上」。别把它当送达回执用。
 *
 * 三条老坑，写在前面，改之前先看一眼：
 * 1. 只认回复落盘，不认「agent 跑完」——子代理跑完也会宣告结束，
 *    照那个响，发一句能听两三次。
 * 2. 冷却和占用分两层：进程内的变量 + 本实例 data/ 下的一道闸。重载后老实例
 *    还挂在事件链上，两边各自计时会两声叠一起，后一声把前一声掐断。
 *    闸必须按实例分开——放临时目录的话，两台宿主会互相等。
 * 3. 用另一个进程放音。同一个进程里两次 winsound 会抢同一个独占通道。
 *
 * 放音脚本固定，音效路径和时长作为参数递过去，不往命令里拼。
 *
 * 平台：只在 Windows 上出声（SoundPlayer / WPF MediaPlayer）。别的系统上
 * 插件照常加载，chime_test 会明说「这台机器不出声」，不报错也不假装。
 */
import type { Context } from "../../core/context.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBody, renderPage, sanitize } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS = process.platform === "win32";
const DATA = join(HERE, "data");

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
  log: join(DATA, "chime.log"),
};

type Config = typeof DEFAULTS;

/** 放音脚本：纯 ASCII，参数化。写一次，之后只用不写。 */
const PLAY_SCRIPT = `param(
  [string]$Path = "",
  [int]$Seconds = 0,
  [string]$Mode = "wav"
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($Mode -eq "beep") {
  [System.Media.SystemSounds]::Asterisk.Play()
  Start-Sleep -Milliseconds 800
  exit 0
}
if (-not (Test-Path -LiteralPath $Path)) { exit 2 }
try {
  if ($Mode -eq "mp3") {
    Add-Type -AssemblyName PresentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    $player.Open(([System.Uri]::new($Path)))
    $player.Play()
    Start-Sleep -Milliseconds (($Seconds * 1000) + 400)
    $player.Close()
  } else {
    $sound = New-Object System.Media.SoundPlayer $Path
    $sound.PlaySync()
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 3
}
exit 0
`;

// 模块级：活得比任何一个实例都长。跨进程重启靠本实例 data/ 下那道闸。
const GUARD_PATH = join(DATA, "chime.guard");
let LAST_PLAY = 0;
let BUSY_UNTIL = 0;

const madeDirs = new Set<string>();

function ensureDir(dir: string): boolean {
  if (madeDirs.has(dir)) return true;
  try {
    mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
    return true;
  } catch {
    return false;
  }
}

/** 把放音脚本落到本实例的 data/ 里，返回路径。内容没变就不重写。 */
function scriptPath(): string | null {
  if (!ensureDir(DATA)) return null;
  const file = join(DATA, "play.ps1");
  try {
    if (readFileSync(file, "utf8") === PLAY_SCRIPT) return file;
  } catch {
    /* 没有就写 */
  }
  try {
    // 纯 ASCII，不带 BOM 也不会被 5.1 按 ANSI 读歪。
    writeFileSync(file, PLAY_SCRIPT, "utf8");
    return file;
  } catch {
    return null;
  }
}

function guardLeft(): number {
  try {
    const until = Number(readFileSync(GUARD_PATH, "utf8").trim() || 0);
    return until - Date.now() / 1000;
  } catch {
    return -1;
  }
}

function guardSet(seconds: number): void {
  if (!ensureDir(DATA)) return;
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
      if (!ensureDir(dir)) return;
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

type Launch = { requested: boolean; error?: string; child?: ChildProcess; mode?: "wav" | "mp3" | "beep" };

/**
 * 起一个进程放音。路径、时长、模式都当参数传，不拼进命令。
 * hold=true 时保持引用，能等到退出码——用于「测试」按钮，好分清
 * 「已经发出去」和「播放器自己报错」。
 */
function play(path: string, hold = false): Launch {
  if (!WINDOWS) return { requested: false, error: `当前系统是 ${process.platform}，只有 Windows 能出声` };
  const script = scriptPath();
  if (!script) return { requested: false, error: "写不了播放脚本（data 目录不可写）" };
  const present = Boolean(path) && existsSync(path);
  const mode = !present ? "beep" : /\.mp3$/i.test(path) ? "mp3" : "wav";
  const seconds = mode === "beep" ? 0 : Math.ceil(audioSeconds(path));
  try {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        present ? path : "",
        String(seconds),
        mode,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    if (!hold) child.unref();
    return { requested: true, child, mode };
  } catch (error: any) {
    return { requested: false, error: error?.message ?? String(error) };
  }
}

/** PowerShell 的 stderr 可能是 UTF-8，也可能是 GBK。先按 UTF-8 解，见到替换符再退回 GBK。 */
function decodeError(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return utf8;
  }
}

/** 等播放进程结束，拿到真实结果。 */
function settle(child: ChildProcess | undefined): Promise<{ ok: boolean; code: number | null; error?: string }> {
  if (!child) return Promise.resolve({ ok: false, code: null, error: "没起进程" });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      if (chunks.reduce((n, b) => n + b.length, 0) < 4000) chunks.push(Buffer.from(chunk));
    });
    child.on("error", (error) => resolve({ ok: false, code: null, error: error.message }));
    child.on("close", (code) =>
      resolve({
        ok: code === 0,
        code,
        error:
          code === 0
            ? undefined
            : decodeError(Buffer.concat(chunks)).trim() ||
              (code === 2 ? "音效文件不见了" : `播放器退出码 ${code}`),
      }),
    );
  });
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

  // 回复落盘 = 这一轮结束（不是「对方收到了」）
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
    const shot = play(wav);
    if (!shot.requested) {
      trace(cfg.log, `error ${shot.error ?? "spawn-failed"}`);
      ctx.logger.warn(`提示音没响：${shot.error ?? "起不了 powershell"}`);
      return;
    }
    LAST_PLAY = now;
    BUSY_UNTIL = now + duration + 0.05;
    guardSet(duration + 0.05);
    trace(cfg.log, `play-requested dur=${duration.toFixed(2)}s elapsed=${elapsed.toFixed(1)}s`);
    ctx.logger.info(`提示音已发出，本轮 ${elapsed.toFixed(1)}s`);
    void settle(shot.child).then((r) => trace(cfg.log, r.ok ? "play-ok" : `play-error ${r.error}`));
  });

  const runTest = async () => {
    await reload();
    const shot = play(wav, true);
    if (!shot.requested) {
      trace(cfg.log, `test requested=false ${shot.error ?? ""}`);
      return { ok: false, requested: false, error: shot.error ?? "没发出去" };
    }
    const done = await settle(shot.child);
    trace(cfg.log, `test requested=true ok=${done.ok} code=${done.code ?? "-"}`);
    if (!done.ok) {
      return {
        ok: false,
        requested: true,
        error: `已经交给播放器，但播放器报错：${done.error ?? `退出码 ${done.code}`}`,
      };
    }
    const used = shot.mode === "beep" ? `系统提示音（音效文件读不到：${wav || "未配置"}）` : wav;
    return { ok: true, requested: true, detail: `已播放：${used}` };
  };

  ctx.tools.register({
    name: "chime_test",
    description: "立刻在宿主电脑上放一次提示音，用来确认声音通道是否还通。不参与回合判定。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      const r = await runTest();
      if (r.ok) return r.detail ?? "已发出提示音";
      return WINDOWS ? `播放失败：${r.error}` : `播放失败：${process.platform} 上不出声，只有 Windows 支持`;
    },
  });

  ctx.web.api("/plugins/chime/test", async (_req: any, res: any) => {
    const reply = (code: number, body: any) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const r = await runTest();
      if (!r.ok) return reply(500, { ok: false, requested: r.requested === true, error: r.error });
      return reply(200, { ok: true, requested: true, detail: r.detail });
    } catch (error: any) {
      return reply(500, { ok: false, requested: false, error: error?.message ?? String(error) });
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

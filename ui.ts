/*! 提示音插件的配置页：出表单、收表单、把提交上来的值洗一遍。
 *
 * 洗的逻辑必须在这边——页面是明文的，谁都改得了。
 */

/** 可编辑字段。没列在这里的一律拒收。 */
const FIELDS = {
  enabled: {
    kind: "boolean",
    label: "启用",
    hint: "关掉之后一个声音都不响，插件仍然加载着，随时可以再打开。",
  },
  sound_path: {
    kind: "text",
    label: "音效文件或目录",
    hint: "填一个文件：每次放同一个。填一个目录：每次从那里面随机抽一个，适合把一串短音效丢进去。留空则用插件自带的 sounds/ 目录。.wav 走 SoundPlayer，.mp3 走 WPF 解码。长音频别直接放：超过十秒的会一直占着，把后面的提示音全挡掉。先切成每段一到四秒的独立短音，丢进一个目录里随机播；自己不会剪，就让 AI 帮你切。",
  },
  min_seconds: {
    kind: "number", min: 0, max: 3600,
    label: "太短的回合不响（秒）",
    hint: "一次回复短于这个秒数就不出声，免得「嗯」「好」也叮一下。填 0 表示不管多短都响。计时从你这句话存下来开始，到回复写进记录为止——不是对方收到的那一刻。",
  },
  cooldown_seconds: {
    kind: "number", min: 0, max: 600,
    label: "两声之间至少隔几秒",
    hint: "连着问几句时，规定两次提示音之间最短的间隔，免得响成一片。",
  },
  channels: {
    kind: "list",
    label: "只在这些通道响",
    hint: "逗号分隔，例如 web, qq；留空表示所有通道都响。",
  },
} as const;

type FieldKey = keyof typeof FIELDS;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** 读 POST 请求体，限 64KB。 */
export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("提交的内容太大了");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("提交的内容不是合法 JSON");
  }
}

/** 只留白名单里的字段，数字钳制，布尔转真布尔，列表拆成数组。 */
export function sanitize(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    const value = (input as any)[key];
    const s: any = spec;
    if (s.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      const step = Number(s.step ?? 1);
      const clamped = Math.max(s.min, Math.min(s.max, n));
      out[key] = step >= 1 ? Math.round(clamped) : Number((Math.round(clamped / step) * step).toFixed(3));
    } else if (s.kind === "boolean") {
      out[key] = value === true || value === "true" || value === "on" || value === 1;
    } else if (s.kind === "select") {
      const text = String(value ?? "").trim();
      if ((s.options as readonly string[]).includes(text)) out[key] = text;
    } else if (s.kind === "list") {
      const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,，\s]+/);
      out[key] = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].slice(0, 16);
    } else {
      out[key] = String(value ?? "").trim().slice(0, 500);
    }
  }
  return out;
}

function field(key: FieldKey, cfg: any): string {
  const spec: any = FIELDS[key];
  const value = cfg?.[key];
  const name = esc(key);
  const label = esc(spec.label);
  const hint = spec.hint ? `<p class="pg-hint">${esc(spec.hint)}</p>` : "";
  let control: string;
  if (spec.kind === "boolean") {
    control = `<label class="pg-row pg-check"><input type="checkbox" name="${name}"${value ? " checked" : ""}><span class="pg-label">${label}</span></label>`;
  } else if (spec.kind === "select") {
    const opts = spec.options
      .map((o: any) => {
        const v = typeof o === "string" ? o : o.value;
        const t = typeof o === "string" ? o : o.label;
        return `<option value="${esc(v)}"${String(value) === v ? " selected" : ""}>${esc(t)}</option>`;
      })
      .join("");
    control = `<label class="pg-row"><span class="pg-label">${label}</span><select name="${name}">${opts}</select></label>`;
  } else if (spec.kind === "number") {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="number" name="${name}" value="${esc(value)}" min="${spec.min}" max="${spec.max}" step="${spec.step ?? 1}"></label>`;
  } else {
    control = `<label class="pg-row"><span class="pg-label">${label}</span><input type="text" name="${name}" value="${esc(value)}"></label>`;
  }
  return `<div class="pg-item">${control}${hint}</div>`;
}
/** 渲染配置页：结构和配色都走 /ui/styles.css，跟管理页同一套。 */
export function renderPage(cfg: any): string {
  const items = (Object.keys(FIELDS) as FieldKey[]).map((k) => field(k, cfg));
  const editable = items
    .reduce<string[]>((acc, cur, i) => {
      if (i % 2 === 0) acc.push(`<div class="pg-pair">${cur}`);
      else acc[acc.length - 1] += `${cur}</div>`;
      return acc;
    }, [])
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>提示音 · 配置</title>
<link rel="stylesheet" href="/ui/styles.css">
<style>
.panel-body .pg-row{display:block;margin:0}
.panel-body .pg-label{display:block!important;font-size:15px!important;font-weight:700!important;color:inherit;margin:0 0 10px;line-height:1.45}
.panel-body .pg-row input[type=text],.panel-body .pg-row input[type=number],.panel-body .pg-row select{display:block;width:100%;box-sizing:border-box;padding:10px 13px;font-size:14px;line-height:1.4;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-family:inherit}
.panel-body .pg-row input:focus,.panel-body .pg-row select:focus{outline:none;border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.12)}
.panel-body .pg-check{display:flex!important;align-items:center;gap:10px;padding-top:2px}
.panel-body .pg-check .pg-label{margin:0}
.panel-body .pg-pair{display:grid;grid-template-columns:1fr 1fr;column-gap:36px;margin:0 0 30px}
.panel-body .pg-pair:last-child{margin-bottom:0}
.panel-body .pg-pair>.pg-item:only-child{grid-column:1/-1}
.panel-body .pg-item{min-width:0}
.panel-body .pg-hint{margin:10px 0 0;font-size:12px;line-height:1.65;color:#797e8c}
.panel-body .pg-ro{display:grid;grid-template-columns:150px 1fr;gap:16px;margin:14px 0;font-size:13px;align-items:baseline}
.panel-body .pg-ro b{font-weight:600;color:#797e8c}
.panel-body .pg-ro code{background:rgba(127,127,127,.12);padding:2px 6px;border-radius:5px;word-break:break-all;font-size:12px}
.pg-actions{display:flex;align-items:center;gap:12px;margin-left:auto}
#msg{font-size:13px;color:#059669}
#msg.err{color:#dc2626}
.pg-result{margin:22px 0 0;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
.pg-result.wait{background:rgba(124,92,255,.10);border-color:rgba(124,92,255,.35);color:#6d4aff}
.pg-result.ok{background:rgba(5,150,105,.10);border-color:rgba(5,150,105,.35);color:#047857}
.pg-result.err{background:rgba(220,38,38,.10);border-color:rgba(220,38,38,.35);color:#b91c1c}
.pg-tip{margin:22px 0 0;padding:14px 16px;border-radius:10px;background:rgba(124,92,255,.07);border:1px solid rgba(124,92,255,.22);font-size:13px;line-height:1.7}
.pg-tip b{display:block;font-weight:700;font-size:14px;color:#6d4aff;margin:0 0 6px}
.pg-tip p{margin:0;color:#797e8c}
@media(max-width:760px){.panel-body .pg-pair{grid-template-columns:1fr}}
</style></head><body>
<form id="f">
<section class="panel"><div class="panel-header"><h2>可编辑</h2><div class="pg-actions"><button class="btn" type="button" id="test">测试</button><button class="btn primary" type="submit" form="f" id="ok">保存</button><span id="msg"></span></div></div><div class="panel-body">
${editable}
<div class="pg-tip"><b>长音频怎么办</b><p>建议不要一次放一长条。切成每段 1～4 秒的独立短音，放进同一个目录，让「音效文件或目录」指向那个目录，它会随机抽一个。自己不方便剪，把文件交给 AI 帮你切，说清要几秒一段、要不要淡入淡出就行。</p></div>
<div id="result" class="pg-result" hidden></div>
</div></section>
</form>
<script type="module">
const form = document.getElementById("f");
const msg = document.getElementById("msg");
const ok = document.getElementById("ok");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  ok.disabled = true; msg.className = ""; msg.textContent = "保存中…";
  try {
    const res = await fetch("/plugins/chime/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    msg.textContent = "已保存，下一次回复时生效";
  } catch (error) {
    msg.className = "err";
    msg.textContent = "没存上：" + (error?.message || error);
  } finally { ok.disabled = false; }
});
const result = document.getElementById("result");
const show = (kind, text) => {
  result.hidden = false;
  result.className = "pg-result " + kind;
  result.textContent = text;
};
document.getElementById("test").addEventListener("click", async () => {
  const btn = document.getElementById("test");
  btn.disabled = true;
  show("wait", "测试中…请稍等");
  try {
    const res = await fetch("/plugins/chime/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const prefix = body.requested === true ? "" : "";
      throw new Error(prefix + (body.error || ("HTTP " + res.status)));
    }
    show("ok", Array.isArray(body.lines) ? body.lines.join(String.fromCharCode(10)) : (body.detail || body.text || "正常"));
  } catch (error) {
    show("err", "测试失败：" + (error?.message || error));
  } finally { btn.disabled = false; }
});
</script></body></html>`;
}

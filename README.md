# chime · 提示音

一轮任务跑完、回复**真的发出去了**之后，在宿主机上响一声。

不是「模型开始说话就响」——它监听的是回复落地之后那个事件。所以长任务会有声音，快速问答不会。

## 怎么装

```sh
git clone https://github.com/SSSSmallSlimeSmile/whalelife-plugin-chime plugins/chime
```

仓库根目录就是插件目录（`plugin.yaml` 和 `index.ts` 在这一层）。放好后重启宿主，插件页里会出现「提示音」。

## 装之前

- **只支持 Windows**。放音用的是 `SoundPlayer` / WPF `MediaPlayer`，别的系统上插件照样加载，但不出声，`chime_test` 会直接说「只有 Windows 支持」。
- 不需要 Python、不需要网络。
- 得有一个能出声的默认输出设备。

**默认输出设备是空的，它就不响，而且不报错。** 这是这个插件最常踩的坑：命令退出码 0、日志有记录，就是没声音。先确认系统右下角那个喇叭能放出音来，再用页面上的「测试」按钮确认。

## 配置

```json
{
  "enabled": true,
  "sound_path": "",
  "wav_path": "",
  "min_seconds": 8,
  "cooldown_seconds": 3,
  "channels": [],
  "log": ""
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sound_path` | 插件自带 `sounds/` 目录 | **优先用它。** 可以是单个音频文件，也可以是目录——是目录时每次随机抽一个，不会连着放同一段 |
| `wav_path` | 插件自带 `sounds/chime-01.wav` | `sound_path` 没填或读不到时的回退，只能单个文件 |
| `min_seconds` | `8` | 这一轮耗时超过多少秒才响。设成 0 就是每轮都响 |
| `cooldown_seconds` | `3` | 两次响之间至少隔多少秒，防连响 |
| `channels` | `[]` | 空 = 所有通道都响；填了就只在这些通道响，比如 `["web"]` |
| `log` | 插件 `data/chime.log` | 播放记录写哪个文件，空则不写 |

支持 wav（`SoundPlayer`）和 mp3（`WPF MediaPlayer`）。mp3 的时长是按文件头算的，VBR 的文件可能提前截断——**建议用 wav**。

## 自带音效

`sounds/` 下四个，都是脚本合成的正弦波加指数包络，没有采样、没有素材来源，随仓库按 MIT 发布：

| 文件 | 时长 | 什么感觉 |
|---|---|---|
| `chime-01.wav` | 0.75s | 两音上行，最像「好了」 |
| `chime-02.wav` | 0.80s | 三音上行，更亮 |
| `chime-03.wav` | 0.65s | 单音轻响，短 |
| `chime-04.wav` | 0.75s | 下行两音 |

要重新生成或改音高，跑 `node tools/make-sounds.mjs`。

想换成自己的音效：把文件丢进 `sounds/`，`sound_path` 指过去就行。

## 页面

`/plugins/chime/`，所有字段都能在页面上改，底部有个「测试」按钮，点一下立刻放一次，用来确认设备通不通。

## 工具

`chime_test` —— 不给参数，立刻放一次。**不参与回合判定**，就是纯测试通道。

编长任务时想确认「到底会不会响」，用这个比自己等一轮快。

## 已知短板

- **音频通道依赖系统默认输出设备。** 设备一换（插耳机、HDMI 接管），可能就静音了，而它不会报错
- **mp3 比 wav 脆弱。** 走 `MediaPlayer`，靠估算时长等待，能转 wav 就转
- **只在一台 Windows 机器上验证过。** 没有在第二台机器、也没在别的 Windows 版本上跑过
- **长音频会占住通道。** 超过十秒的那一声会把后面的提示音全挡掉。切成每段 1～4 秒的独立短音放进目录随机播

## 许可

MIT，见 [LICENSE](LICENSE)。自带音效同为 MIT，由 `tools/make-sounds.mjs` 生成。

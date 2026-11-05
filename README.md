# 网易云音乐 · Fushi 音源插件

非官方 Fushi 音乐模块插件，通过网易云音乐网页接口提供搜索、专辑、歌单、艺人、MV、
播放取流、歌词、首页推荐、用户歌单、喜欢和登录能力。

- 插件 ID：`io.github.creeperboo.fushi.netease`
- 版本：`0.1.5`
- 源码：[github.com/creeperboo/fushi-netease-plugin](https://github.com/creeperboo/fushi-netease-plugin)
- 下载：[最新 Release](https://github.com/creeperboo/fushi-netease-plugin/releases/latest)
- 插件 API：`1`
- 宿主：仅支持带音源插件宿主的 **Fushi develop**（PR #2634），稳定版 3.0.x 和 iOS 不支持。

## 功能

| 能力 | 说明 |
| --- | --- |
| 搜索 | 歌曲 / 专辑 / 艺人 / 歌单分页搜索 |
| 最佳匹配 | 按名称匹配艺人、歌单，必要时回退专辑 |
| 专辑 / 歌单 / 艺人 | 详情与曲目列表，歌单最多取 2000 首 |
| 艺人专辑 / MV | 分页列表，MV 可直接播放 |
| 取流 | 标准 / 高 / 无损 / Hi-Res；不返回试听片段 |
| 歌词 | 行级 LRC 或逐字 YRC；只返回原文，不返回翻译 |
| 歌词搜索 | 为本地或第三方曲目按标题、艺人、时长查找歌词 |
| 首页 | 每日推荐、每日推荐歌单（登录后）、推荐歌单、新歌速递、排行榜 |
| 用户歌单 | 登录后读取自己的和收藏的歌单，「我喜欢」排第一 |
| 喜欢 | 读取与切换平台“喜欢”状态 |
| 登录 | 扫码、Fushi 内网页登录、手机号验证码，或粘贴浏览器 Cookie |

## 变更记录

### 0.1.5

- 改用网易云客户端 eapi（`interface.music.163.com`）并持久化 deviceId；扫码改为 `type=1`，
  与可正常扫码的社区插件对齐。
- 新增手机号验证码登录；账号/VIP 改为 eapi 查询，支持黑胶 SVIP / 黑胶 VIP / 音乐包 badge。
- 新增每日推荐歌单、官方综合搜索最佳匹配、专辑/艺人/首页歌曲详情回填、喜欢走 eapi、
  喜欢歌单封面补齐。
- 媒体地址统一 https，移除 `insecureHttp` 权限；保留质量降级和无翻译歌词。

### 0.1.4

- 修复会员等级识别：网易云网页账号可能返回 `profile.vipType=110`，现在按账号字段
  `account.vipType=11` 和 100/110 归一化处理，VIP 歌曲不再被错误标灰。
- 会员状态未知时不再武断标灰 `fee=1` 曲目，交给取流阶段给出真实错误。
- 取流增加音质降级：Hi-Res → 无损 → 高 → 标准，避免高音质不可用时整首播放失败。

### 0.1.3

- 增加 `webAuth` 和「网页登录」：扫码被网易云拒绝时，可在 Fushi 内登录网页并自动捕获 Cookie。
- 喜欢/取消喜欢补充 `csrf_token`，在结束后回查服务器喜欢列表，并清理「我喜欢的音乐」
  歌单缓存，避免宿主本地假成功。
- 清理旧插件歌词缓存后，之前带翻译的歌曲只显示原文。
- 制卡失败已反馈给 Fushi 作者：
  [#2777](https://github.com/hajisensai/Fushi/issues/2777)。

### 0.1.2

- 扫码返回网易云 `8821` 时给出明确提示：刷新二维码立即确认，或改用「粘贴 Cookie」。
- 真机联调：验证登录页稳定性、搜索、播放、歌词、查词和 MV；记录宿主制卡音频限制。

### 0.1.1

- 修复扫码登录页约 2 秒后黑屏：所有 pending 扫码轮询现在都会返回 `qr.content`，宿主不再因
  `qr` 缺失停止轮询并解引用空值。
- 移除歌词翻译：宿主没有插件级翻译开关，插件不再返回 `translation`，避免强制显示。
  已缓存的旧歌词可能在约 1 天内仍带翻译，换一首未播放曲目或等缓存过期即可。
- 真机联调：验证登录、搜索、播放、歌词、查词、MV、首页、用户歌单和喜欢。

## 目录

```
.
├── plugin/
│   ├── manifest.json
│   └── src/
│       ├── index.js      # 能力入口
│       ├── state.js      # 常量、缓存、存储键
│       ├── net.js        # HTTP、Cookie 罐、plain/weapi、错误
│       ├── map.js        # 网易云 JSON → Fushi 实体
│       ├── browse.js     # 搜索、专辑、歌单、艺人
│       ├── media.js      # 歌曲与 MV 取流
│       ├── lyrics.js     # 歌词、歌词搜索、歌词抓取
│       ├── auth.js       # 账号与登录
│       └── home.js       # 首页、用户歌单、喜欢
├── sdk/                  # 官方 music-plugin-sdk（仅开发用，不打包）
├── dist/                 # 打包产物（不打包 sdk）
└── README.md
```

插件本身没有 npm 依赖、没有构建步骤。模块使用带扩展名的相对路径
`require('./net.js')`，由宿主 QuickJS 运行时加载。

## 获取 SDK

`pack` / `check` / `smoke` 使用 Fushi 官方 `tools/music-plugin-sdk`。如果本地没有
`sdk/`，从 Fushi 仓库稀疏检出：

```bash
git clone --filter=blob:none --sparse https://github.com/hajisensai/hibiki.git .tmp-hibiki
cd .tmp-hibiki
git sparse-checkout set tools/music-plugin-sdk
git checkout develop
cp -r tools/music-plugin-sdk ../sdk
cd ..
rm -rf .tmp-hibiki
```

## 验证

```bash
cd plugin

# 清单、文件与导出检查
node ../sdk/fushi-plugin.mjs check

# 匿名能力：账号、首页、搜索、专辑、歌单、艺人、MV、取流、歌词
node ../sdk/fushi-plugin.mjs smoke . --query "生日快乐" --strict

# 单项调试，--trace 显示请求，--full 显示完整结果
node ../sdk/fushi-plugin.mjs run . search '{"query":"晴天","type":"song","page":0,"pageSize":20}' --trace --full
node ../sdk/fushi-plugin.mjs run . stream '{"id":"1450707819","quality":"standard"}' --trace --full
```

开发者首次扫码登录可通过 SDK 交互完成：

```bash
node ../sdk/fushi-plugin.mjs login .
```

本地开发状态保存在 `plugin/.fushi-dev/`，可用
`node ../sdk/fushi-plugin.mjs reset .` 清除。

## 打包

```bash
mkdir -p dist
node sdk/fushi-plugin.mjs pack plugin --out "dist/io.github.creeperboo.fushi.netease-0.1.5.fushiplug"
node sdk/fushi-plugin.mjs inspect "dist/io.github.creeperboo.fushi.netease-0.1.5.fushiplug"
```

`pack` 会生成 `files.json` 并校验包结构。如需 Ed25519 签名，可先执行
`node sdk/fushi-plugin.mjs keygen --out my-plugin-key.pem`，再给 `pack` 加
`--key my-plugin-key.pem`。私钥不要提交到仓库。

## 安装

1. 使用带插件宿主的 Fushi develop 版本。
2. 打开「设置 › 音乐 › 音源插件 › 从文件安装」，选择 `dist/*.fushiplug`。
3. 核对插件 ID、权限和签名者，确认安装。
4. 在音乐页把音源切换为「网易云音乐」。
5. 进入插件账号设置登录。

## 登录

插件提供四种方式：

- **扫码登录**：宿主显示二维码，用网易云音乐 App 扫码并在手机上确认。
- **网页登录**：宿主用内嵌浏览器打开网易云登录页，登录后自动捕获 `MUSIC_U`；需要
  `webAuth` 权限。
- **手机号验证码**：填写手机号和短信验证码；可能触发网易云安全验证。
- **粘贴 Cookie**：从浏览器开发者工具复制 `music.163.com` 的 Cookie，至少包含
  `MUSIC_U` 或 `MUSIC_A`。

登录 Cookie 保存在宿主的加密 `credentials` 中，不写入普通 `storage`；插件不会把
Cookie 放进媒体请求头、日志或结果。退出登录会删除本地凭据。

## 权限

| 权限 | 用途 |
| --- | --- |
| `network` | 访问网易云 API 与媒体 CDN |
| `storage` | 缓存匿名 Cookie 罐 |
| `credentials` | 加密保存登录 Cookie |
| `webAuth` | 在 Fushi 内嵌浏览器完成网易云网页登录并接收 Cookie |

域名清单：

- `music.163.com`：网页 API / 登录页
- `interface.music.163.com`：客户端 eapi
- `*.music.126.net` / `*.vod.126.net`：封面、歌曲音频、MV（https）
- `vod.126.net`：裸域兜底

`*.host` 只匹配子域；所有封面、音频、MV 和重定向目标都必须命中清单，否则宿主会
隐藏封面或拒绝播放。新增接口后请用 `--trace` 和媒体探测重新核对域名。

## 播放与版权

- 已登录 VIP/音乐包账号应能在账号行显示对应 badge；若没有 badge，VIP 曲目会被按非会员处理。
- 未登录或确认非会员遇到 VIP 曲目会给出明确中文错误，不会返回试听片段。
- `fee === 4` 的付费专辑曲目即使登录也保持不可播，需要平台购买。
- 无版权或地区受限曲目返回「该曲目暂不可播放（可能受版权或地区限制）」。
- 用户选择无损/Hi-Res 但曲目不可用时，会自动降级到高/标准，而不是直接播放失败。
- Fushi「设置 › 音乐 › 服务器码率」同时作为插件音质上限：`原样/0` 对应无损，`320 kbps`
  对应高，更低值对应标准；插件会在不可用时自动降级。
- 登录或升级后账号行没有 VIP badge 时，退出设置页再进入刷新账号状态。
- 插件只向宿主返回媒体 URL 和 `User-Agent` / `Referer` 请求头，不下载音频，
  不伪造 URL。

## 缓存与限制

- 内存缓存：搜索 5 分钟、浏览 30 分钟、歌词 24 小时、取流 5 分钟、首页 10 分钟、
  账号 60 秒；登录/退出会清空。
- 持久化只保存 Cookie 罐与加密登录 Cookie。
- 歌单最多 2000 首，歌曲详情每批 500 首；搜索页大小上限 100，艺人列表上限 50。
- QuickJS 运行时无 `fetch` / 定时器 / `TextEncoder`，只使用 `fushi.*`、`Promise`、
  `JSON`、`Date` 和相对 `require`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `check` 报清单/导出错误 | 确认 17 个能力都已导出，且 `manifest.capabilities` 一致 |
| 接口返回 `-460` / `400` | 网易云风控或加密校验失败；插件会先在 plain/weapi 间回退，仍失败请稍后重试 |
| 登录后仍显示未登录 | Cookie 可能过期；退出后重新扫码或粘贴新的 `MUSIC_U` |
| 账号行没有 VIP badge | 0.1.5 起用 eapi 查询 SVIP/黑胶/音乐包，并兼容 `vipType=110`；升级后重新打开账号行，仍无 badge 请反馈 |
| 很多 VIP 曲目灰色 | 确认账号行有「黑胶 VIP」或「音乐包」；登录后需要重新搜索/刷新，旧搜索页可能保留登录前的不可播标记 |
| 扫码后提示 `8821` | 网易云拒绝了这次扫码授权。刷新二维码后立即在手机上确认；仍失败请改用「网页登录」「手机号验证码」或「粘贴 Cookie」 |
| 旧歌曲仍有翻译 | 0.1.1 之前的歌词缓存可能保留约 1 天；换未播放曲目、等待过期或清除插件歌词来源缓存后重开 |
| 封面不显示 / 无法播放 | 媒体主机可能不在域名清单；用 `run ... --trace` 核对实际主机 |
| 安装被拒 | 用 `inspect` 查看具体原因；确认宿主是 develop 版且 API 为 1 |
| 首页为空 | 未登录时没有每日推荐；网络或接口异常时单个分区会被跳过 |

## 已知限制

- 仅桌面 develop 版可安装；iOS 不提供插件宿主。
- 网易云接口是网页非公开 API，可能随时变动或触发风控。
- 逐字歌词取决于平台是否为该曲目提供 YRC；没有时回退到行级 LRC。
- 歌词搜索使用网易云搜索结果，可能匹配到翻唱或现场版。
- 歌单超过 2000 首时只返回前 2000 首。
- 宿主当前把插件曲目的 `fushi-music-plugin://` URI 直接交给 ffmpeg 裁剪制卡音频，
  插件曲目的制卡会报 `sentence audio export failed`；歌词查词不受影响。已提交
  [#2777](https://github.com/hajisensai/Fushi/issues/2777)，需要宿主支持插件取流后修复。
- 喜欢/取消喜欢后，宿主「我喜欢的音乐」详情页不会自动刷新；退出列表再进入即可看到最新内容。
  插件已清理自身歌单缓存，这是宿主页面缓存行为，已提交
  [#2778](https://github.com/hajisensai/Fushi/issues/2778)。
- 歌词只返回原文，不返回翻译；宿主歌词缓存可能让已播放过的曲目继续显示旧翻译约 1 天。

## 免责声明

本项目是非官方插件，与网易云音乐无隶属关系。它调用网页接口，可能随时失效；
账号使用风险由使用者自行承担。请勿分享 Cookie，不要将本项目用于商业分发或
绕过平台付费内容。VIP、付费专辑和版权受限曲目仍受网易云平台限制。

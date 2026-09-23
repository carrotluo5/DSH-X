# DSH-X for macOS（社区移植）

上游 [yyh-001/DSH-X](https://github.com/yyh-001/DSH-X) 只发 Windows 安装包（`DSH-Setup.exe`，
Inno Setup + Rust 原生启动器 + 便携 node.exe）。这份检出把它整个搬到 macOS：

- **管理器逻辑照搬**：同一个管理页（选版本、启动 / 停止 / 重启 / 更新 / 卸载 dsh、插件管理）
- **原生壳重写**：上游 `launcher/` 是 `#![cfg(windows)]` 的 Rust 代码（tao + wry + tray-icon），
  这里用系统自带的 AppKit + WKWebView 重写了一份（`native/main.swift`），
  产物同样是**一个不依赖浏览器的本地应用** `release/DSH-X.app`
- **不引入 Electron**：壳编译出来 200 KB，加上 node 侧代码一共几 MB（Electron 版至少 150 MB）

## 结论先说

上游代码本来就是 Node.js + 浏览器页面，**核心逻辑是跨平台的**，只有 6 处 Windows 假设挡路。
本移植把这些改动收敛到一个新文件 `platform.mjs`，其余按调用点替换，改动很小：

| 上游行为 | macOS 上的问题 | 现在的做法 |
| --- | --- | --- |
| `systemNpmRoots()` 只认 `/usr/local/lib/node_modules` | Apple Silicon 的 Homebrew 装到 `/opt/homebrew/lib/node_modules`，列表里**一个已装版本都看不到** | `npmRootCandidates()` 补上 `/opt/homebrew/...`、`~/.npm-global/...`、pnpm 全局目录 |
| `process.env.APPDATA` 决定设置/日志目录 | mac 上没有 `APPDATA`，日志和 `settings.json` 会落到安装目录里 | `appSettingsDir()` → `~/Library/Application Support/DSH`（可用 `DSH_X_HOME` 覆盖） |
| `killTree()` 只在 win32 走 taskkill，其它平台只 `kill(pid)` | dsh 自己再起 worker / pnpm，孙进程漏下来继续占端口 | `spawnDsh()` 在类 Unix 上 `detached: true` 自成进程组，`killTree()` 整组发信号 |
| `withBundledRuntime()` 找 `node/node.exe` | mac 上永远找不到（也没有便携运行时） | 认 `hasBundledRuntime()`；mac 用系统 Node/npm/pnpm，并在日志里提示 pnpm 是插件安装的前置 |
| 开机自启读写 `HKCU\...\Run` 注册表 | 直接抛「只支持 Windows」 | `setLaunchAgent()` 写 `~/Library/LaunchAgents/com.dsh-x.launcher.plist` + `launchctl load` |
| 启动器自更新下载 `DSH-Setup.exe` 并 `powershell -Command Start-Process` | 拿不到 exe，PE 头校验必然失败 | `checkSelfUpdate()` 在 mac 上直接返回「没有启动器更新」，界面上的「更新」胶囊自动隐藏（dsh 本体照常能更新） |
| 便携 Node / npm / pnpm（Windows 包里自带） | mac 上没有，`dsh plugin` 靠 PATH 找 pnpm | 用系统 Node/npm/pnpm；`.app` 外壳在起管理器前把 Homebrew / nvm / npm 全局的 bin 补进 PATH（见下） |

### PATH：从 Finder 起来的进程没有 Homebrew

这是移植时最不显眼、但一定会踩的一条：**双击 .app 时进程只拿到
`/usr/bin:/bin:/usr/sbin:/sbin`**，不读 `~/.zshrc`，所以 `/opt/homebrew/bin` 不在 PATH 里。
管理器本身不受影响（它用绝对路径起 node），但 `dsh plugin` 是 pnpm 的透传器，靠 PATH 找
pnpm——不补就是这个现象：插件页一点「安装」就失败，日志里还写着「没找到 pnpm」，而用户
在终端里 `which pnpm` 明明有。

`scripts/macos/DSH-X` 里的处理顺序：

1. 按已知位置补 PATH：`/opt/homebrew/{bin,sbin}`、`/usr/local/{bin,sbin}`、`~/.local/bin`、
   `npm prefix -g`/bin、`~/.nvm/versions/node/<最新>/bin`
2. 还找不到 pnpm，就用 `env -i /bin/zsh -l -i -c 'printf %s "$PATH"'` 问一次用户的登录 shell
   （`env -i` 是为了不让它的 rc 递归回到本脚本；输出只取最后一行且必须形如 `/*:*`，
   免得把 shell 的欢迎语塞进 PATH）
3. 补完 export 给 node 子进程，并把最终 PATH 写进 `app-launch.log` 方便排查

## 原生壳（native/main.swift）怎么工作

对应关系是「一个职责一个对应物」，不是逐行翻译：

| 上游 Rust 壳（Windows） | macOS 壳 |
| --- | --- |
| `tao` 事件循环 + `wry` 内嵌 WebView | `NSApplication` + `WKWebView` |
| `tray-icon` 托盘菜单 | `NSStatusItem` 状态栏图标 + 应用菜单 |
| `ShellExecuteW` 打开外链 | `NSWorkspace.open` |
| 父子进程靠 stdout 里的 `__DSH_SHOW__` 标记通信 | loopback HTTP 桥（见下） |
| 端口写死在 `%APPDATA%\DSH\settings.json` | 同左，另外把**实际端口**回传给壳 |

三条值得单独说的设计：

**1. 壳起 node，并接管它的生命周期。** `Process` 拉起 `node start.js`（带 `DSH_APP_WINDOW=1`），
stdout/stderr 直接进 `manager.log`。退出时先 `terminate()` 再等 4 秒，不退出就 `SIGKILL`——
所以不会留下孤儿 dsh。注销 / 关机 / `kill` 给的 SIGTERM、SIGINT、SIGHUP 也转成同一条
收尾路径（默认动作是立刻死掉，那才是会漏进程的路径）。

**2. 端口回传走一次性 FIFO。** 配置端口被占用时管理器会往后顺延，壳不能假设是 3780。
Windows 的 Foundation `Process` 有 `executionFileDescriptorMapping` 可以多挂一个 fd，
**macOS 没有**，所以改成壳 `mkfifo` → 把路径放进 `DSH_SHELL_PORT_FIFO` → node 侧
`openSync/writeSync/closeSync` 写完就关，壳读到就开窗口。端口文件（`port`）照旧写，
命令行直接跑 `start.js` 时靠它。

**3. dsh 页面走系统浏览器。** 页面点「启动」→ `POST /api/open` → server 的
`host.onOpenUrl` → 壳的 loopback 桥 → `NSWorkspace.open`。不在应用里开 WKWebView：
那个视图是不透明的，透明桌宠（dsh-pet）叠在上面会变成一整块黑底。桥只认本机地址。

## 依赖

- macOS 12+（部署目标 `LSMinimumSystemVersion=12.0`；Apple Silicon 或 Intel 都行）
- **Node >= 22.19**（Homebrew、nvm、官方 pkg 装的都可以）
- `pnpm`（只有装 / 卸插件时才需要）：`brew install pnpm` 或 `npm i -g pnpm`
- npm >= 10（Node 22+ 自带）——安装 dsh 版本时用

## 下载

不需要自己构建。从 [Releases](https://github.com/carrotluo5/DSH-X/releases/latest) 下载
`DSH-X-0.1.13-mac.dmg`，打开后把 DSH-X 拖进「应用程序」。

第一次打开如果被 Gatekeeper 拦住，右键 DSH-X →「打开」，或在终端执行：

```sh
xattr -dr com.apple.quarantine /Applications/DSH-X.app
```

## 构建

```sh
npm run macos                          # → release/DSH-X.app（原生窗口版）
node scripts/build-macos.mjs --dmg     # 额外生成 release/DSH-X-<版本>-mac.dmg
node scripts/build-macos.mjs --zip     # 额外生成 release/DSH-X-<版本>-mac.zip
node scripts/build-macos.mjs --web     # → release/DSH-X-web.app（浏览器版外壳）
```

构建会调 `xcrun swiftc` 编 `native/main.swift`（只依赖 Command Line Tools，不需要 Xcode），
再用 `sips` + `iconutil` 生成 `icon.icns`，最后 ad-hoc 签名（`codesign --sign -`），
避免从别处拷过来被 Gatekeeper 报「已损坏」。首次打开如果仍被拦，右键 →「打开」一次即可。

`.app` 只有几 MB：不下便携 Node（Windows 包要下一整个 node-v22-win-x64），源码和图标
直接拷进去，Node / npm / pnpm 用系统已有的。

**Intel 机器注意**：脚本会分别编 arm64 与 x86_64 再 `lipo` 合成通用二进制，但
Command Line Tools 里**没有** x86_64 的 Swift 兼容库（`libswiftCompatibility56.a`
只有 arm64/arm64e），所以只有装了 Xcode 才能出通用二进制；否则自动退化成当前架构的
单架构产物（构建日志里会写 `Non-fat file: ... architecture: arm64`）。
Apple Silicon 上用法完全不受影响。

## 使用

```sh
open release/DSH-X.app
```

双击等同于此。原生窗口版的行为：

- **管理页开在应用自己的窗口里**，不碰系统浏览器
- **dsh 页面用系统浏览器打开**（点「启动」），默认端口 3080，被占用再往后顺延
- 菜单栏图标（右上角）常驻：打开管理页 / 重新载入 / 退出
- 关掉管理页窗口只关窗口，管理服务继续留在菜单栏图标后面；再点图标或 `⌘1` 会重新打开。
  真正退出走 `⌘Q` 或菜单里的「退出 DSH-X」，退出时 node 和 dsh 一起收掉
- 管理页地址仍是 `http://127.0.0.1:3780/`（端口可在设置页改；被占用会自动往后顺延，
  实际端口记在 `~/Library/Application Support/DSH/port`，壳靠 FIFO 拿的是同一个值）
- 开机自启：设置页里的「开机自启」开关，写的是 `~/Library/LaunchAgents`
- 日志：`~/Library/Application Support/DSH/manager.log`（壳自己的日志在同目录的
  `shell.log`）

`--web` 那个浏览器版（`DSH-X-web.app`）走的是另一条路：`LSUIElement` 纯后台、
没有应用窗口，起服务后用系统浏览器打开管理页——适合想拿浏览器当界面、或者要把它
挂到开机自启里当常驻服务的场景。

数据位置（与 Windows 版布局一致，只是根目录不同）：

```
~/Library/Application Support/DSH/
  settings.json        管理页设置
  config.json          已装版本清单
  data/versions/<ver>/ 启动器自己装的 dsh 版本
  port / manager.log / shell.log / app-launch.log
~/.dsh/                dsh 本体数据（profile、插件、会话）——与系统 dsh 共用
```

## 开发模式

不打包也能跑（等于上游的 `npm start`）：

```sh
cd DSH-X-mac
node start.js          # 起管理器并打开浏览器
node server.js         # 只起服务，不开页面
```

`DSH_X_HOME=/tmp/dshx-test node start.js` 可以把设置/日志/版本目录挪到别处，
不碰 `~/Library`。

## 与上游的差异清单

改动都带了注释，方便以后同步上游：

- 新增 `platform.mjs`：所有平台差异集中在这里（Windows 分支保持上游行为不变）
- `settings.js`：`SETTINGS_DIR`、`fallbackDataDir()`、`launchCommand()`、
  `autoStartEnabled()` / `setAutoStart()` 接 macOS
- `server.js`：导入 platform 助手；`systemNpmRoots()`、`withBundledRuntime()`、
  `killTree()` 改为调用 platform；`spawnDsh()` 加 `detached`；`checkSelfUpdate()`
  在 mac 上短路；`startServer()` 写 `port` 文件并回调 `host.onReady`；启动时提示缺 pnpm
- 新增 `host.onOpenUrl` 钩子：`openLocalUrl()` 先问宿主，宿主接不住才开系统浏览器
  （Windows 上没人挂这个钩子，行为不变）
- `start.js`：`LOG_DIR` 改走 `appSettingsDir()`；新增 `reportPortToShell()`（FIFO 回传端口）
  与 `openInShellOrBrowser()`（把页面交给原生壳）；`setHost()` 挪到 `startServer()` 之前
  （`onReady` 要能收到端口）
- `package.json`：加 `macos` / `macos:dmg` 脚本
- 新增 `native/main.swift`（原生壳）、`scripts/build-macos.mjs`（构建）、
  `scripts/macos/DSH-X`（浏览器版外壳，`--web` 用）

上游后续更新时，`git diff` 一下这几个文件即可对照。

## 已知限制

- **仍然需要本机有 Node >= 22.19**：壳很轻是因为没把 Node 打进去。要做成完全自包含，
  得把 `node-v22-darwin-arm64` 也拷进 `Contents/Resources`（+约 50 MB）并在壳里优先用它，
  目前没做
- 通用二进制（Intel + Apple Silicon）需要 Xcode；只有 Command Line Tools 时产物是单架构
- 启动器自身不能一键更新（上游只发 exe）；要更新就重新 `git pull` + 重新构建
- 管理页的窗口按钮用页面自绘那套（`.win-controls`），它只在**页面 URL 带 `?window=1`** 时
  由页面自己加上 `.app-window` 类才显形。macOS 壳刻意不带这个参数，所以管理页走系统红黄绿，
  两套不会同时出现（这条是刻意留的）。注意别混：`DSH_APP_WINDOW` 是**环境变量**，只影响
  `start.js` 的壳桥接，跟页面上的窗口按钮无关
- **上游契约依赖**：macOS 壳依赖页面「`?window=1` → `.app-window`」这套约定（上游 Windows 版
  自己也用）。上游若改这两个名字，macOS 管理页的窗口外观要跟着调
- `dsh plugin` 走系统 pnpm，版本和 Windows 包内置的 pnpm 8 可能不同；如果插件安装
  撞到 pnpm 的 peer/linker 行为差异，可以在 profile 目录的 `.npmrc` 里调
  （`node-linker=hoisted` 之类，server.js 里本来就有这条兼容路径）
- 插件市场预装（`seedMarket`）首次安装某版本时会跑一次 pnpm，需要网络
- 安装 dsh 版本时 `registry.js` 会挑一个和本机 Node 匹配的 npm（本机 npm 太旧就下到
  `DSH-X-mac/node/`），这条逻辑没有平台分支，mac 上照常走

## 许可

与上游一致：MIT（见 `LICENSE`）。这是社区移植，非 DeepSeek 官方产品。

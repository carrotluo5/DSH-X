/**
 * 平台差异集中在这里。
 *
 * 原版 DSH-X 只发 Windows 安装包，平台相关的东西散在 server.js / settings.js /
 * registry.js / start.js 里（APPDATA、Program Files、node.exe、taskkill、注册表
 * 自启、DSH-Setup.exe）。移植到 macOS 时把它们收敛到本文件，其余文件只调这里的
 * 函数——这样上游改了别的逻辑，同步时冲突面最小。
 *
 * Windows 分支保持原样（本文件不改动 Windows 上的行为）。
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** 便携运行时里的 node 文件名：Windows 是 node.exe，类 Unix 是 node。 */
export const NODE_BIN = IS_WINDOWS ? 'node.exe' : 'node'

/**
 * 设置 / 日志目录。
 *
 * Windows 用 %APPDATA%\DSH；macOS 用常规的 ~/Library/Application Support/DSH
 * （路径带空格没关系：worker 兼容补丁靠 NODE_PATH 传目录，NODE_OPTIONS 里只写
 * 不带空格的裸文件名，见 server.js 的 WORKER_COMPAT）。
 */
export function appSettingsDir() {
  if (process.env.DSH_X_HOME) return process.env.DSH_X_HOME
  if (process.env.APPDATA) return join(process.env.APPDATA, 'DSH')
  if (IS_MAC) return join(homedir(), 'Library', 'Application Support', 'DSH')
  return join(ROOT, 'data')
}

/**
 * 全局 npm 安装根目录候选。
 *
 * 原版只认 Windows 的几个位置加 /usr/local/lib/node_modules。Homebrew 在
 * Apple Silicon 上把全局包装在 /opt/homebrew/lib/node_modules，不补上这颗
 * 根本看不到用户已经装好的 dsh（列表里会一个版本都没有）。
 */
export function npmRootCandidates() {
  const roots = []
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
  if (process.env.npm_config_prefix) roots.push(join(process.env.npm_config_prefix, 'node_modules'))
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (base) roots.push(join(base, 'nodejs', 'node_modules'))
  }
  roots.push('/usr/local/lib/node_modules')
  if (IS_MAC) {
    roots.push('/opt/homebrew/lib/node_modules')          // Apple Silicon
    roots.push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
    roots.push(join(homedir(), 'Library', 'pnpm', 'global', '5', 'node_modules'))
  } else {
    roots.push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  }
  return [...new Set(roots)]
}

/** 便携运行时的目录（Windows 包里自带 node/npm/pnpm；macOS 上用系统的那套）。 */
export function bundledRuntimeDir() {
  return join(ROOT, 'node')
}

/** 便携运行时是否真的可用。 */
export function hasBundledRuntime() {
  return existsSync(join(bundledRuntimeDir(), NODE_BIN))
}

/**
 * 结束一棵进程树。
 *
 * Windows 用 taskkill /T。类 Unix 上原本只 kill 直接子进程，而 dsh 自己会再起
 * worker / pnpm，那些孙进程会漏下来继续占着端口——所以 spawnDsh 那边把子进程放进
 * 独立进程组（detached），这里整组发信号。
 */
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return
  if (IS_WINDOWS) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* 进程已经没了 */ }
  }
}

/** macOS 自启用 LaunchAgent（对应 Windows 那边的 HKCU\...\Run 注册表项）。 */
const LAUNCH_AGENT_LABEL = 'com.dsh-x.launcher'

function launchAgentFile() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function launchAgentStatus() {
  return existsSync(launchAgentFile())
}

/**
 * launchd plist 的内容。
 *
 * 单独抽出来是为了能在任何机器上验证结构（plutil -lint），不用真的往
 * ~/Library/LaunchAgents 写文件——真实的写入路径在受限环境里碰不到。
 */
export function launchAgentPlist() {
  const app = join(ROOT, 'DSH-X.app')
  const args = existsSync(app)
    ? ['/usr/bin/open', '-a', app]
    : [process.execPath, join(ROOT, 'start.js')]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((item) => `    <string>${xmlEscape(item)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${xmlEscape(ROOT)}</string>
</dict>
</plist>
`
}

/**
 * 开 / 关登录自启。
 *
 * plist 里优先用 `open -a DSH-X.app`：登录时由 launchd 拉起 open，open 再把
 * 启动器拎起来，进程不挂在 launchd 的会话里，跟双击图标的效果一致。
 * 还没有 .app（比如直接 npm start 跑的开发检出）时退回 node start.js。
 */
export async function setLaunchAgent(enabled) {
  const file = launchAgentFile()
  if (!enabled) {
    try { await execFileAsync('launchctl', ['unload', file]) } catch { /* 没加载过 */ }
    try { await rm(file, { force: true }) } catch { /* 不在了 */ }
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, launchAgentPlist())
  // 先卸再装，反复开关不会留下重复的注册项
  try { await execFileAsync('launchctl', ['unload', file]) } catch { /* 没加载过 */ }
  try {
    await execFileAsync('launchctl', ['load', file])
  } catch (error) {
    throw new Error(`写入 ${file} 成功，但 launchctl load 失败：${error?.message || error}`)
  }
}

/** PATH 上有没有这个命令（用来做 pnpm / node 之类的前置检查）。 */
export function hasCommand(name) {
  const paths = String(process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of paths) {
    if (existsSync(join(dir, name))) return true
  }
  return false
}

/**
 * 管理页实际用的端口记在 appSettingsDir()/port。
 *
 * 双击 .app 的外壳（scripts/macos/DSH-X）靠它判断「是不是已经在跑」，以及该打开
 * 哪个端口——配置端口被占用时 startServer 会顺延，外壳不该假设 3780。
 */
export function portFile() {
  return join(appSettingsDir(), 'port')
}

export async function writePortFile(port) {
  try {
    await mkdir(appSettingsDir(), { recursive: true })
    // 先写临时文件再改名：外壳脚本随时可能读到这个文件，不能让它读到半个端口号
    const tmp = `${portFile()}.tmp`
    await writeFile(tmp, String(port))
    await rename(tmp, portFile())
  } catch { /* 记不下来也不影响管理器本身 */ }
}

export async function clearPortFile() {
  try { await rm(portFile(), { force: true }) } catch { /* 不在了 */ }
}

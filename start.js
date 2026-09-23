import { execFile } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  setHost,
  shutdown,
  startServer,
} from './server.js'
import { resolvePort } from './settings.js'
import { appSettingsDir } from './platform.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = resolvePort()
const MANAGER_URL = `http://127.0.0.1:${PORT}/`
// 由原生壳拉起时它设这个变量：管理页装进它自己的窗口，托盘也归它，
// 这里就只剩服务本身，不用再往系统浏览器里开页面。
// Windows 是 DSH.exe，macOS 是 native/DSHShell.swift 编出来的壳。
const APP_WINDOW = process.env.DSH_APP_WINDOW === '1'
// 原生壳的 loopback 桥：dsh 页面的 URL 交给它开成原生窗口，而不是丢给系统浏览器
const SHELL_BRIDGE = process.env.DSH_SHELL_BRIDGE || ''
// 平台差异集中在 platform.mjs：Windows 走 %APPDATA%\DSH，macOS 走
// ~/Library/Application Support/DSH（原版这里只看 APPDATA，mac 上会落到安装目录）。
const LOG_DIR = appSettingsDir()
const LOG = join(LOG_DIR, 'manager.log')

/**
 * 把最终端口回传给原生壳。
 *
 * macOS 的 Foundation Process 不能像 Windows 那样给子进程多挂一个 fd，所以走一条
 * 一次性 FIFO：壳 mkfifo 后把路径放在 DSH_SHELL_PORT_FIFO 里，我们写完就关。
 * 端口文件（platform.mjs 的 writePortFile）照旧写——命令行直接跑 start.js 时靠它。
 */
function reportPortToShell(port) {
  const fifo = process.env.DSH_SHELL_PORT_FIFO
  if (!fifo) return
  let fd = -1
  try {
    fd = openSync(fifo, 'w')
    writeSync(fd, String(port))
  } catch (error) {
    log('回传端口给原生壳失败', error)
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* 已经关了 */ }
    }
  }
}

/** 页面要不要开在系统浏览器里：原生壳模式下不抢浏览器。 */
async function openInShellOrBrowser(target) {
  if (APP_WINDOW && SHELL_BRIDGE) {
    try {
      const res = await fetch(SHELL_BRIDGE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: target }),
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return
      log(`原生壳没接住这个地址（HTTP ${res.status}），改用系统浏览器`)
    } catch (error) {
      log('原生壳桥不可用，改用系统浏览器', error)
    }
  }
  openPage(target)
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(' ')}\n`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, line)
  } catch { /* ignore */ }
  console.error(...args)
}

/** cmd 会二次解析命令行，URL 里出现它的元字符就不安全（原因见 server.js 的 openExternal）。 */
const CMD_SAFE_URL = /^[A-Za-z0-9\-._~:/?#\[\]@$'*,;=+]+$/

function openPage(target = MANAGER_URL) {
  if (process.platform === 'win32') {
    if (!CMD_SAFE_URL.test(target)) {
      log(`地址含不能安全打开的字符，已跳过：${target}`)
      return
    }
    execFile('cmd', ['/c', 'start', '', target], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
}

/**
 * 让 DSH.exe 把窗口叫到前面。父子之间没有别的 IPC，就约定 stdout 里一行标记：
 * 父进程接着这个管道，看到这行就把窗口显示出来。
 */
function requestShow() {
  if (!APP_WINDOW) return false
  process.stdout.write('__DSH_SHOW__\n')
  return true
}

/** 叫回管理页：有 app 窗口就让它显示，没有就照旧开浏览器标签页。 */
async function showManager() {
  if (requestShow()) return
  openPage(MANAGER_URL)
}

/** 唤醒已经在跑的那个实例（端口可能因为顺延而不是配置值）。 */
async function wakeExisting(port = PORT) {
  const base = `http://127.0.0.1:${port}/`
  try {
    const res = await fetch(`${base}api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return true
    log(`唤醒已有实例失败 HTTP ${res.status}`)
  } catch (error) {
    log('唤醒已有实例失败', error)
  }
  return false
}

async function main() {
  log('启动管理器', ROOT)
  // 钩子必须在 startServer() 之前挂好：
  //   onWake    另一个实例双击启动时会立刻打 /api/wake，晚一步就丢了这个请求
  //   onReady   端口是 startServer() 内部定的（可能顺延），它一监听上就回调
  //   onOpenUrl 原生壳模式下把 dsh 页面开进应用窗口，而不是系统浏览器
  setHost({
    onWake: () => showManager(),
    onReady: (port) => reportPortToShell(port),
    onOpenUrl: APP_WINDOW && SHELL_BRIDGE ? (url) => openInShellOrBrowser(url) : null,
  })
  try {
    await startServer()
  } catch (error) {
    // 端口被自己的另一个实例占着：唤醒它、把窗口叫出来，然后退出（不起第二个管理器）。
    // 被别的程序占用的情况已经在 startServer() 里顺延掉了，走不到这里。
    if (error && error.code === 'EALREADY') {
      const port = error.port || PORT
      log(`管理页已经在 ${port} 端口上跑着，通知它把窗口叫出来`)
      await wakeExisting(port)
      await showManager()
      if (!APP_WINDOW) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/state`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
          const data = await res.json()
          if (data.running?.url) openPage(data.running.url)
        } catch { /* 管理页开了就够 */ }
      }
      return
    }
    throw error
  }

  // 窗口在原生壳那边（Windows 的 DSH.exe / macOS 的 DSHShell），本进程只剩服务。
  // 打开启动器只把界面摆出来，不再默认拉起 dsh——跑哪个版本、什么时候跑，由用户在界面上点。
  // 更新也一样：启动时不打扰，更新按钮留在界面上，点了才弹确认。
  if (!APP_WINDOW) openPage(MANAGER_URL)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown().finally(() => process.exit(0))
    })
  }
}

main().catch((error) => {
  log(error)
  process.exit(1)
})

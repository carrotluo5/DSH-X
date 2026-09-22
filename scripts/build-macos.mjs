#!/usr/bin/env node
/**
 * 把当前检出打包成 macOS 应用。
 *
 * 默认产出**原生窗口版** `release/DSH-X.app`：里面是一个用 AppKit + WKWebView 写的
 * 小壳（native/DSHShell.swift），管理页和 dsh 页面都开在应用自己的窗口里，不碰系统
 * 浏览器。等于把上游 Windows 那个 Rust 壳（tao/wry/tray-icon）用系统自带框架重写了一遍。
 *
 * 变体：
 *   --web   只做「浏览器版」壳（release/DSH-X-web.app）：起服务后用系统浏览器打开，
 *           跟 scripts/macos/DSH-X 一个路子，适合不想要应用窗口的场景
 *   --dmg   额外生成 release/DSH-X-<版本>-mac.dmg
 *   --zip   额外生成 release/DSH-X-<版本>-mac.zip
 *
 * 跟 Windows 的 scripts/pack.mjs 不同，这里不下便携 Node，也不做安装包：
 *   - Node / npm / pnpm 用系统已有的（Homebrew / nvm / 官方 pkg 都行）
 *   - 分发就是一个 .app 目录，拖进「应用程序」即可
 * 所以体积只有几 MB。代价是目标机器得先有 Node >= 22.19——壳会检查，
 * 缺了弹原生提示告诉用户装什么。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const RELEASE = join(ROOT, 'release')
const SHELL_SWIFT = join(ROOT, 'native', 'main.swift')

/** 随 .app 带走的源码/资源：不含 docs、native、release、launcher、vendor。 */
const SHIP = [
  'server.js', 'start.js', 'settings.js', 'plugins.js', 'registry.js',
  'plugin-tool.js', 'platform.mjs', 'package.json', 'package-lock.json',
  'compat', 'perf', 'public', 'scripts/macos', 'LICENSE', 'README.md', 'MACOS.md',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`)
  return result
}

function quiet(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' })
}

function makeIcns(resources) {
  const png = join(ROOT, 'assets', 'icon.png')
  if (!existsSync(png)) {
    console.warn('没有 assets/icon.png，跳过图标')
    return false
  }
  const iconset = join(RELEASE, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
      const out = quiet('sips', ['-z', String(px), String(px), png, '--out', join(iconset, name)])
      if (out.status !== 0) {
        console.warn(`sips 生成 ${name} 失败，跳过图标`)
        return false
      }
    }
  }
  const icns = join(resources, 'icon.icns')
  const out = quiet('iconutil', ['-c', 'icns', iconset, '-o', icns])
  rmSync(iconset, { recursive: true, force: true })
  if (out.status !== 0) {
    console.warn('iconutil 失败，跳过图标')
    return false
  }
  return true
}

function infoPlist({ background }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>DSH-X</string>
  <key>CFBundleDisplayName</key><string>DSH-X</string>
  <key>CFBundleIdentifier</key><string>com.dsh-x.launcher</string>
  <key>CFBundleVersion</key><string>${PKG.version}</string>
  <key>CFBundleShortVersionString</key><string>${PKG.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>DSH-X</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 本机 http://127.0.0.1 的页面（管理页 + dsh Web）在应用窗口里加载 -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
${background ? '  <!-- 浏览器版：纯后台启动器，不在 Dock 里占位 -->\n  <key>LSUIElement</key><true/>\n' : ''}</dict>
</plist>
`
}

/**
 * 挑一个能用的 SDK。
 *
 * Command Line Tools 自带的 `MacOSX.sdk` 有时比 swiftc 旧一个版本，swiftc 会直接
 * 拒绝（"this SDK is not supported by the compiler"）。这里优先用带版本号的 SDK，
 * 取版本最高的那个；都没有就退回默认。
 */
function pickSdkFlag() {
  const root = '/Library/Developer/CommandLineTools/SDKs'
  try {
    const versions = readdirSync(root)
      .map((name) => /^MacOSX([\d.]+)\.sdk$/.exec(name))
      .filter(Boolean)
      .map((match) => ({ name: match[0], version: Number(match[1]) }))
      .sort((a, b) => b.version - a.version)
    if (versions.length) return ['-sdk', join(root, versions[0].name)]
  } catch { /* 没有 CLT 的 SDK 目录就交给 swiftc 自己找 */ }
  return []
}

/** 编译原生壳。产物同时含 arm64 与 x86_64（Apple Silicon / Intel 通用）。 */
function buildShellBinary(destination) {
  if (!existsSync(SHELL_SWIFT)) throw new Error(`缺少 ${SHELL_SWIFT}`)
  const sdk = pickSdkFlag()
  console.log(`编译原生壳${sdk.length ? `（SDK ${sdk[1]}）` : ''}`)
  const slices = []
  for (const target of ['arm64-apple-macos12.0', 'x86_64-apple-macos12.0']) {
    const out = join(RELEASE, `.DSH-X-${target}`)
    const result = quiet('xcrun', [
      'swiftc', '-O', '-swift-version', '5',
      ...sdk,
      '-target', target,
      // 模块缓存必须落在可写目录：受限环境里默认的 ~/Library/Caches/clang 可能是只读的
      '-module-cache-path', join(RELEASE, 'swift-module-cache'),
      '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'Network',
      '-o', out, SHELL_SWIFT,
    ])
    if (result.status !== 0) {
      // 某一架构编不出来（比如 SDK 缺该切片）就只留另一个，别整个构建挂掉
      console.warn(`编译 ${target} 失败：\n${(result.stderr || '').trim()}`)
      continue
    }
    slices.push(out)
  }
  if (!slices.length) throw new Error('原生壳编译失败（看上面的 swiftc 报错）')
  rmSync(join(RELEASE, 'swift-module-cache'), { recursive: true, force: true })
  if (slices.length === 1) cpSync(slices[0], destination)
  else run('lipo', ['-create', ...slices, '-output', destination])
  for (const slice of slices) rmSync(slice, { force: true })
  chmodSync(destination, 0o755)
  console.log((quiet('lipo', ['-info', destination]).stdout || '').trim())
}

/** 组装 .app：Contents/{MacOS,Resources}，源码进 Resources/app。 */
function assembleApp({ name, background, executable }) {
  const app = join(RELEASE, `${name}.app`)
  const contents = join(app, 'Contents')
  const macosDir = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  const appSrc = join(resources, 'app')

  rmSync(app, { recursive: true, force: true })
  mkdirSync(macosDir, { recursive: true })
  mkdirSync(resources, { recursive: true })
  mkdirSync(appSrc, { recursive: true })

  for (const item of SHIP) {
    const from = join(ROOT, item)
    if (!existsSync(from)) continue
    cpSync(from, join(appSrc, item), { recursive: true })
  }

  const target = join(macosDir, 'DSH-X')
  cpSync(executable ?? join(ROOT, 'scripts', 'macos', 'DSH-X'), target)
  chmodSync(target, 0o755)

  writeFileSync(join(contents, 'Info.plist'), infoPlist({ background }))
  const icon = makeIcns(resources)

  // ad-hoc 签名：未签名的 .app 从别处拷过来会被 Gatekeeper 报「已损坏」
  const sign = quiet('codesign', ['--force', '--deep', '--sign', '-', app])
  if (sign.status !== 0) console.warn('codesign ad-hoc 失败（不影响本机使用）:', (sign.stderr || '').trim())
  quiet('touch', [app])

  console.log(`已生成 ${app}${icon ? '' : '（没有图标）'}`)
  return app
}

function makeDmg(app) {
  const dmg = join(RELEASE, `DSH-X-${PKG.version}-mac.dmg`)
  rmSync(dmg, { force: true })
  run('hdiutil', ['create', '-volname', 'DSH-X', '-srcfolder', app, '-ov', '-format', 'UDZO', dmg])
  console.log(`已生成 ${dmg}`)
}

function makeZip(app) {
  const zip = join(RELEASE, `DSH-X-${PKG.version}-mac.zip`)
  rmSync(zip, { force: true })
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  console.log(`已生成 ${zip}`)
}

const args = process.argv.slice(2)
if (process.platform !== 'darwin') throw new Error('这个脚本只能在 macOS 上跑')
mkdirSync(RELEASE, { recursive: true })

let app
if (args.includes('--web')) {
  app = assembleApp({ name: 'DSH-X-web', background: true })
} else {
  const binary = join(RELEASE, '.DSH-X-shell')
  buildShellBinary(binary)
  app = assembleApp({ name: 'DSH-X', background: false, executable: binary })
  rmSync(binary, { force: true })
}

if (args.includes('--dmg')) makeDmg(app)
if (args.includes('--zip')) makeZip(app)

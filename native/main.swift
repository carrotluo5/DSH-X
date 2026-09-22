// DSH-X 的 macOS 原生壳。
//
// 等于上游 launcher/main.rs 在 macOS 上的对应物，但实现路线完全不同：那边用
// tao + wry + tray-icon 那套 Rust 库，这边直接用系统自带的 AppKit + WKWebView，
// 所以既不需要 Rust 工具链，也不需要 Electron（不额外背一个 Chromium）。
// 编译：scripts/build-macos.mjs 调 swiftc，只依赖 Command Line Tools。
//
// 职责：
//   1. 起 node start.js，从 fd3 读回管理页端口
//   2. 管理页装进一个原生窗口
//   3. 页面里的 window.open / target=_blank 一律开成原生窗口，不留裸 webview
//   4. dsh 自己要开页面时（POST /api/open → server 的 host.onOpenUrl → 本进程的
//      loopback 桥）也开成原生窗口，而不是丢给系统浏览器
//   5. 菜单栏图标常驻；退出时把 node 连同 dsh 一起收掉
//
// 刻意没做的：内嵌页面自绘的标题栏。管理页在浏览器模式下会画一套 .win-controls
// 窗口按钮，原生窗口已经有红黄绿三个灯，再画一套只会重复。

import AppKit
import Foundation
import Network
import WebKit

// MARK: - 环境

let fileManager = FileManager.default

/// node 的路径。可以用 DSH_X_NODE 覆盖（比如 Homebrew 装在别处、或用 nvm 的版本）。
let dshNodePath: String = {
    if let explicit = ProcessInfo.processInfo.environment["DSH_X_NODE"], !explicit.isEmpty {
        return explicit
    }
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "\(NSHomeDirectory())/.local/bin/node",
    ]
    for candidate in candidates where fileManager.isExecutableFile(atPath: candidate) {
        return candidate
    }
    return "node"
}()

let appRoot = Bundle.main.bundleURL
    .appendingPathComponent("Contents/Resources/app", isDirectory: true)
let homeDir = fileManager.homeDirectoryForCurrentUser
let settingsDir = ProcessInfo.processInfo.environment["DSH_X_HOME"].map {
    URL(fileURLWithPath: $0, isDirectory: true)
} ?? homeDir.appendingPathComponent("Library/Application Support/DSH", isDirectory: true)
let managerLogURL = settingsDir.appendingPathComponent("manager.log")
let shellLogURL = settingsDir.appendingPathComponent("shell.log")

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] [shell] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
    try? fileManager.createDirectory(at: settingsDir, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: shellLogURL) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? Data(line.utf8).write(to: shellLogURL)
    }
}

// MARK: - 管理服务

/// 起 node start.js，从一条一次性 FIFO 读回它最终用的端口（配置端口被占用时会往后
/// 顺延，所以不能假设一定是 3780）。已经有管理页在跑就复用，不再起第二个。
///
/// 为什么用 FIFO 而不是 fd3：macOS 的 Foundation `Process` 不带
/// `executionFileDescriptorMapping`（那是 Windows 侧的 API），node 侧
/// `fs.writeSync(3, ...)` 没有对应的通道。FIFO 是两边都有的最小公约数。
func makePortChannel() -> (path: String, read: () -> String?) {
    let path = NSTemporaryDirectory() + "dsh-x-port-\(UUID().uuidString)"
    guard mkfifo(path, 0o600) == 0 else {
        log("mkfifo 失败，改用端口文件轮询")
        return ("", { nil })
    }
    let read: () -> String? = {
        let descriptor = open(path, O_RDONLY)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor); unlink(path) }
        var buffer = [UInt8](repeating: 0, count: 64)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        guard count > 0 else { return nil }
        return String(decoding: buffer[0..<count], as: UTF8.self)
    }
    return (path, read)
}

@MainActor
final class ServerProcess {
    private(set) var port: Int?
    private var process: Process?
    private let onDied: (Int32) -> Void
    private var finished = false

    init(onDied: @escaping (Int32) -> Void) {
        self.onDied = onDied
    }

    func start(completion: @escaping (Int?) -> Void) {
        if let reuse = ServerProcess.existingPort() {
            log("复用已在运行的管理页，端口 \(reuse)")
            port = reuse
            completion(reuse)
            return
        }

        let channel = makePortChannel()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: dshNodePath)
        task.currentDirectoryURL = appRoot
        task.arguments = ["start.js"]

        let combined = Pipe()
        task.standardOutput = combined
        task.standardError = combined
        task.standardInput = Pipe()

        var environment = ProcessInfo.processInfo.environment
        environment["DSH_APP_WINDOW"] = "1"
        environment["DSH_X_HOME"] = settingsDir.path
        if !channel.path.isEmpty { environment["DSH_SHELL_PORT_FIFO"] = channel.path }
        if Bridge.shared.port != 0 {
            environment["DSH_SHELL_BRIDGE"] = "http://127.0.0.1:\(Bridge.shared.port)/open"
        }
        task.environment = environment

        combined.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            FileHandle.standardError.write(Data(text.utf8))
        }

        task.terminationHandler = { proc in
            log("node 退出，code=\(proc.terminationStatus)")
            DispatchQueue.main.async { self.onDied(proc.terminationStatus) }
        }

        do {
            try task.run()
        } catch {
            log("起 node 失败：\(error)")
            completion(nil)
            return
        }
        process = task
        log("node 已起，pid=\(task.processIdentifier)")

        guard !channel.path.isEmpty else {
            // mkfifo 不可用：退回到等端口文件出现
            pollPortFile(deadline: Date().addingTimeInterval(20), completion: completion)
            return
        }
        readChannel(channel.read, completion: completion)
    }

    private func readChannel(_ read: @escaping () -> String?, completion: @escaping (Int?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let text = read()          // 阻塞到 node 写好端口（或 FIFO 对端关闭）
            DispatchQueue.main.async {
                guard !self.finished else { return }
                if let text, let value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)), value > 0 {
                    self.finished = true
                    self.port = value
                    completion(value)
                } else {
                    self.pollPortFile(deadline: Date().addingTimeInterval(5), completion: completion)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            guard !self.finished else { return }
            self.finished = true
            completion(nil)
        }
    }

    private func pollPortFile(deadline: Date, completion: @escaping (Int?) -> Void) {
        if let value = ServerProcess.existingPort() {
            guard !finished else { return }
            finished = true
            port = value
            completion(value)
            return
        }
        if Date() > deadline {
            guard !finished else { return }
            finished = true
            completion(nil)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.pollPortFile(deadline: deadline, completion: completion)
        }
    }

    /// 端口文件由 start.js 落盘（macOS 上在 ~/Library/Application Support/DSH/port）。
    static func existingPort() -> Int? {
        let file = settingsDir.appendingPathComponent("port")
        guard let text = try? String(contentsOf: file, encoding: .utf8),
              let value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)),
              value > 0, value <= 65535 else { return nil }
        guard let url = URL(string: "http://127.0.0.1:\(value)/api/ping") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let text = String(data: data, encoding: .utf8), text.contains("dsh-x") { ok = true }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 2)
        return ok ? value : nil
    }

    func stop() {
        guard let process, process.isRunning else { return }
        log("收掉 node pid=\(process.processIdentifier)")
        process.terminate()                     // SIGTERM：server 会先停 dsh 再退出
        let deadline = Date().addingTimeInterval(4)
        while process.isRunning, Date() < deadline {
            usleep(120_000)
        }
        if process.isRunning {
            log("node 没在 4 秒内退出，强杀")
            kill(process.processIdentifier, SIGKILL)
        }
    }
}

// MARK: - 原生窗口桥

/// node 要开新窗口时（用户点了「启动 dsh」）走这个 loopback 服务把 URL 交给原生层。
/// 用 HTTP 而不是 WKWebView 的 postMessage：请求方是 node 进程，不是页面里的 JS，
/// 它没法往 webview 里发消息。
@MainActor
final class Bridge {
    static let shared = Bridge()
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    var onOpen: ((URL) -> Void)?
    private var onReady: ((UInt16) -> Void)?

    /// 等端口真正绑上再回调。node 必须拿到这个端口才能把 dsh 页面交回壳，
    /// 所以不能在 start() 返回时就假设 port 已经有值。
    func start(ready: ((UInt16) -> Void)? = nil) {
        onReady = ready
        do {
            let parameters = NWParameters.tcp
            parameters.requiredInterfaceType = .loopback
            let listener = try NWListener(using: parameters, on: .any)
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.handle(connection) }
            }
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let value = listener.port?.rawValue {
                        Task { @MainActor in
                            self.port = value
                            log("桥接服务就绪 http://127.0.0.1:\(value)/open")
                            self.onReady?(value)
                            self.onReady = nil
                        }
                    }
                case .failed(let error):
                    log("桥接服务失败：\(error)")
                default:
                    break
                }
            }
            listener.start(queue: .main)
            self.listener = listener
        } catch {
            log("桥接服务起不来：\(error)")
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .main)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, _, _ in
            let reply = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"
            if let data, let text = String(data: data, encoding: .utf8),
               text.hasPrefix("POST "), let url = Bridge.url(in: text) {
                DispatchQueue.main.async { self.onOpen?(url) }
            }
            connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    /// 从 HTTP 请求体里取 url 字段。请求是本机 node 发的，格式固定（JSON.stringify），
    /// 但仍然只认 127.0.0.1/localhost/::1，别的地址一律丢掉。
    nonisolated private static func url(in request: String) -> URL? {
        guard let range = request.range(of: #""url"\s*:\s*"([^"]+)""#, options: .regularExpression) else { return nil }
        let matched = String(request[range])
        guard let colon = matched.firstIndex(of: ":"),
              let open = matched[colon...].firstIndex(of: "\""),
              let close = matched.lastIndex(of: "\""),
              open < close else { return nil }
        let raw = String(matched[matched.index(after: open)..<close])
        let unescaped = raw.replacingOccurrences(of: "\\/", with: "/")
        guard let url = URL(string: unescaped), let host = url.host,
              ["127.0.0.1", "localhost", "::1"].contains(host) else { return nil }
        return url
    }
}

// MARK: - 窗口

/// 管理器窗口。关掉只关窗口，管理服务继续在菜单栏图标后面跑；
/// 再点图标或 ⌘1 会重新打开。真正退出走菜单 / ⌘Q。
final class ManagerWindow: NSWindow {}

// MARK: - 应用

@MainActor
final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private var server: ServerProcess!
    private var managerWindow: ManagerWindow?
    private var managerWebView: WKWebView?
    private var statusItem: NSStatusItem?
    private var managerURL: URL?
    private var quitting = false
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("壳启动，node=\(dshNodePath)，app=\(appRoot.path)")
        buildMenu()
        buildStatusItem()
        installSignalHandlers()
        // dsh 页面走系统浏览器。WKWebView 是不透明的，透明桌宠（dsh-pet）叠在上面
        // 会变成一整块黑底；系统浏览器没有这个问题。
        Bridge.shared.onOpen = { url in NSWorkspace.shared.open(url) }
        Bridge.shared.start { [weak self] _ in
            self?.startServer()
        }
        // 桥起不来也不能把管理页卡死：两秒后照常起 node，页面会退回系统浏览器
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.startServer()
        }
    }

    private var serverStarted = false

    private func startServer() {
        guard !serverStarted else { return }
        serverStarted = true
        server = ServerProcess { [weak self] code in
            guard let self, !self.quitting else { return }
            self.alert("管理服务退出了（code \(code)）",
                       "日志：\(managerLogURL.path)")
        }
        server.start { [weak self] port in
            guard let self else { return }
            guard let port else {
                self.alert("管理服务没能启动",
                           "node 没能按预期起来。日志：\(managerLogURL.path)")
                return
            }
            self.showManager(port: port)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false        // 关窗不等于退出，退出走菜单 / 状态栏
    }

    /// Dock 图标被点（窗口已关、或被别的窗口盖住）时系统走这里，不走菜单动作。
    /// 只把管理页叫回来——dsh 窗口是浏览器里的，不该被这次点击抢到前台。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openManager()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.stop()
    }

    /**
     * SIGTERM / SIGINT 也要走同一条收尾路径。
     *
     * 正常退出是「退出 DSH-X」菜单或 Cmd+Q，走 applicationWillTerminate；但注销、
     * 关机、`kill`、调试器停止给的都是信号，默认动作是立刻死掉——那样 node 和它下面
     * 的 dsh 会变成孤儿继续占着端口。这里把信号转成正常退出。
     */
    private func installSignalHandlers() {
        for raw in [SIGTERM, SIGINT, SIGHUP] {
            signal(raw, SIG_IGN)                 // 先忽略默认动作，再让 GCD 接管
            let source = DispatchSource.makeSignalSource(signal: raw, queue: .main)
            source.setEventHandler { [weak self] in
                log("收到信号 \(raw)，按正常退出收尾")
                self?.quit()
            }
            source.resume()
            signalSources.append(source)
        }
    }

    // MARK: 菜单 / 状态栏

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 DSH-X",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "打开管理页", action: #selector(openManager), keyEquivalent: "1")
        appMenu.addItem(withTitle: "重新载入管理页", action: #selector(reloadManager), keyEquivalent: "r")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 DSH-X", action: #selector(quit), keyEquivalent: "q")
        for entry in appMenu.items where entry.action != nil { entry.target = self }
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu

        NSApp.mainMenu = main
    }

    /// 菜单栏图标：18×18 点正方形，圆角按边长 22%。
    /// 尺寸必须落在菜单栏高度（约 22pt）里面，再大就会被裁成一条。
    /// 用绘制闭包而不是自己建位图：闭包的 rect 就是整张图，draw(in:) 会把
    /// 原图完整缩进去，显示时再按屏幕倍率光栅化。
    private func menuBarIcon() -> NSImage? {
        let iconURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/icon.icns")
        guard let source = NSImage(contentsOf: iconURL) ?? NSApp.applicationIconImage else { return nil }
        let side: CGFloat = 18
        let radius = side * 0.22
        let canvas = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).addClip()
            source.draw(in: rect)
            return true
        }
        canvas.isTemplate = false
        return canvas
    }

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            // 用应用图标本身，不要 isTemplate：模板模式会把彩色图按 alpha 涂成单色，
            // 这张图几乎没有不透明像素，菜单栏里看起来就是空白。
            button.image = menuBarIcon()
            button.imageScaling = .scaleProportionallyDown
            button.imagePosition = .imageOnly
            button.toolTip = "DSH-X"
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "打开管理页", action: #selector(openManager), keyEquivalent: "")
        menu.addItem(withTitle: "重新载入", action: #selector(reloadManager), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 DSH-X", action: #selector(quit), keyEquivalent: "")
        for entry in menu.items where entry.action != nil { entry.target = self }
        item.menu = menu
        statusItem = item
    }

    // MARK: 窗口

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    private func showManager(port: Int) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        managerURL = url

        let window = ManagerWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "DSH-X"
        window.minSize = NSSize(width: 900, height: 600)
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.delegate = self

        let view = makeWebView()
        view.frame = window.contentView?.bounds ?? .zero
        view.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(view)
        window.center()
        window.makeKeyAndOrderFront(nil)

        managerWindow = window
        managerWebView = view
        view.load(URLRequest(url: url))
        NSApp.activate(ignoringOtherApps: true)
        log("管理页窗口已开 \(url.absoluteString)")
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === managerWindow {
            // 只关窗口，服务留在菜单栏后面；下次「打开管理页」再重建
            managerWindow = nil
            managerWebView = nil
            return
        }
    }

    // MARK: WKUIDelegate / WKNavigationDelegate

    /// 页面里的 window.open / target=_blank。本机地址（dsh 页面）交给系统浏览器，
    /// 外链同样交给系统浏览器。不在应用里再开 WKWebView——透明桌宠叠不上。
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    /// 非本机地址（Star 链接、文档）交给系统浏览器，别在应用窗口里跑。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        let local = ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
        if !local, navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // MARK: 动作

    @objc private func openManager() {
        if managerWindow == nil, let port = server?.port {
            showManager(port: port)
            return
        }
        managerWindow?.deminiaturize(nil)
        managerWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func reloadManager() {
        guard let url = managerURL else { return }
        if managerWindow == nil, let port = server?.port {
            showManager(port: port)
            return
        }
        managerWebView?.load(URLRequest(url: url))
    }

    @objc private func quit() {
        quitting = true
        server?.stop()
        NSApp.terminate(nil)
    }

    private func alert(_ title: String, _ body: String) {
        log("\(title)：\(body)")
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
}

// MARK: - 入口

// 顶层代码跑在主线程上，但编译器不把它当 MainActor 上下文（main.swift 的顶层隔离
// 在 Swift 5 语言模式下不生效），所以这里显式进一次主 actor。App 上的 @MainActor
// 因此不用摘掉——摘了反而会让 NSWindow / WKWebView 的调用失去检查。
@MainActor
func runApplication() {
    let application = NSApplication.shared
    let appDelegate = App()
    application.delegate = appDelegate
    application.setActivationPolicy(.regular)
    application.run()
}

MainActor.assumeIsolated { runApplication() }

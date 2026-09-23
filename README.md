<p align="center">
  <a href="https://github.com/carrotluo5/DSH-X/releases/latest/download/DSH-X-0.1.13-mac.dmg">下载</a>
  ·
  <a href="https://github.com/carrotluo5/DSH-X">Star</a>
</p>

DeepSeek Harness 的 macOS 启动器。选一个版本，在系统浏览器里启动 DSH。

社区移植，不是 DeepSeek 官方产品。基于 [yyh-001/DSH-X](https://github.com/yyh-001/DSH-X)。

## 下载

[DSH-X-0.1.13-mac.dmg](https://github.com/carrotluo5/DSH-X/releases/latest/download/DSH-X-0.1.13-mac.dmg)

打开后把 DSH-X 拖进「应用程序」。第一次如果提示无法验证开发者，右键 DSH-X → 打开。

需要：

- macOS 12 或更新，Apple Silicon。Intel Mac 跑不了这一份。
- Node.js 22.19 或更新。应用不内置 Node。
- `pnpm`，只有安装或卸载插件时需要。

## 使用

从启动台打开 DSH-X。管理页在应用自己的窗口里，地址是 `http://127.0.0.1:3780/`。点「启动」后，DSH 页面用系统浏览器打开，默认端口 3080。

界面可以跟随系统外观，也能在设置里手动选亮色 / 暗色。升级 dsh 之前会先弹确认（列出当前版本和要升到的版本），不会在启动时自动开始升级。

关掉窗口不会退出。退出用菜单里的「退出 DSH-X」，dsh 会一起停掉。

设置和日志在 `~/Library/Application Support/DSH`。DSH 的数据在 `~/.dsh`，和命令行的 dsh 共用。

## 构建

需要 Command Line Tools。

```sh
npm run macos        # release/DSH-X.app
npm run macos:dmg    # 额外生成 dmg
```

和上游的差异、端口、开机自启见 [MACOS.md](MACOS.md)。

## 原项目

[yyh-001/DSH-X](https://github.com/yyh-001/DSH-X)。原项目只提供 Windows 安装包，Windows 的打包流程在这个分支里没有改。

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

## 杀软误报

启动器没有代码签名，而它的行为和启发式里的「下载器」有几分像：会拉起 `cmd` / `powershell` 打开链接、可以写开机自启项、自带一份 Node 运行时、自更新时会下载安装包。所以偶尔会被 Windows Defender 或其他杀软拦下来。

遇到了这样处理：

- 先在杀软的「保护历史记录」里确认被拦的具体条目；
- 把安装目录（默认 `%LOCALAPPDATA%\Programs\DSH`）加进排除项，可以先恢复使用；
- 把误报提交给微软：<https://www.microsoft.com/en-us/wdsi/filesubmission>（选「软件开发者」，上传 `DSH-Setup.exe`），一般 1–2 天会撤销误报；
- 国内杀软（360、火绒等）各有误报提交入口，同样适用；
- 下载后 SmartScreen 提示「未知发布者」是正常的（没有代码签名），点「仍要运行」即可。

## 使用

从启动台打开 DSH-X。管理页在应用自己的窗口里，地址是 `http://127.0.0.1:3780/`。点「启动」后，DSH 页面用系统浏览器打开，默认端口 3080。

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

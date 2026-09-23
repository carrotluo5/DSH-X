DSH-X for macOS

把 DSH-X 拖进「应用程序」文件夹，再从启动台打开。

运行环境：
  • macOS 12 或更新，Apple Silicon（M 系列）。Intel 机器跑不了这一份。
  • Node.js 22.19 或更新：https://nodejs.org  或 brew install node
  • pnpm，只有装 / 卸插件时需要：brew install pnpm

第一次打开如果提示无法验证开发者：右键 DSH-X → 打开。
或在终端执行：xattr -dr com.apple.quarantine /Applications/DSH-X.app

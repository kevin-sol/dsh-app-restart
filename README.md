# dsh-app-restart

为 DeepSeek Harness 桌面版在侧边栏底部加两个动作：左边「刷新」重载页面，右边「重启」重启整个应用。
安装或更新插件后需要重启才能加载新代码，这时点「重启」即可，不必再去任务栏里找窗口、关掉、重开。

插件本体在 [`apps/dsh-app-restart/`](apps/dsh-app-restart) 子目录里，文档也在那里：
**[apps/dsh-app-restart/README.md](apps/dsh-app-restart/README.md)**
（使用、实现方式、诊断、目录结构、限制、许可证）。

## 安装

只在 **Windows 上的 DSH 桌面版**可用 —— 重启助手是一个 PowerShell 脚本，包本身声明了 `"os": ["win32"]`。
「刷新」在任何环境都能用；「重启」在非桌面环境里会提示 `仅桌面应用支持重启`。

1. **设置 → 插件 → 添加插件**，填本仓库地址 `https://github.com/kevin-sol/dsh-app-restart`。
   应用会克隆仓库、解析 `apps/dsh-app-restart/package.json`，然后提示你重启；用侧边栏底部新出现的「重启」按钮就能完成这一步。
2. **插件市场**（`dshmarket`）里搜 `dsh-app-restart`，等线上条目合并后可以一键安装。

用 `dsh` 命令行则是：

```sh
dsh plugin --profile <profile> add github:kevin-sol/dsh-app-restart
```

装好或更新插件本身之后，按一次「重启」—— 宿主侧代码只在下一次启动时加载，这个按钮就是为这一步准备的。

## 许可

[MIT](apps/dsh-app-restart/LICENSE)
# dsh-app-restart

为 DeepSeek Harness 桌面版在侧边栏底部加两个动作：左边「刷新」重载页面，右边「重启」重启整个应用。
安装或更新插件后需要重启才能加载新代码，这时点「重启」即可，不必再去任务栏里找窗口、关掉、重开。

```bash
# 桌面版：设置 → 插件 → 添加插件，填入本仓库地址
# 或命令行
dsh plugin --profile <profile> add github:kevin-sol/dsh-app-restart
```

安装后需要重启一次才生效；之后就用侧边栏里的按钮。

> 仓库根目录就是包本身：`package.json` 在根上声明 `dsh.bundle` 与 `dsh.client`。
> 插件管理器按“源码目录 / 包根”读清单，因此子目录布局装不上，扁平结构才装得上。

## 使用

侧边栏底部（账号行上方）出现一行两个按钮：**⟳ 刷新** ｜ **⏻ 重启**。

- **刷新**：`window.location.reload()`，只重载这个页面。适用于页面状态不对、Client 半身刚热更新完想立刻看到效果，或者只是想清掉当前视图的情况——它不动 Host 进程，也不中断后台任务。
- **重启**：
  1. **点一下** → 进入倒计时（3 秒），按钮变成「3 秒后重启 —— 点击取消」。
  2. 倒计时内**再点一下**即可取消。
  3. 倒计时结束自动重启整个应用。

宽侧栏时图标 + 文案，中英文随界面语言自动切换。

关于窄轨道（56px）：在 Windows 桌面版里，侧栏折叠后宿主会把整个底部区域
（`[data-windows-titlebar] .collapsed .footArea{display:none}`）隐藏，所以那时两个按钮
根本不会显示——不是本插件的问题。插件的 `.is-rail` 分支（竖排、各 36×36 图标位、
长文案只进 tooltip 与无障碍名）是为没有窗口标题栏的模式准备的，在那里会生效。

## 实现方式（为什么不是简单杀进程）

- Electron 主进程没有向插件开放 relaunch 通道：Desktop Host 的 IPC 事件白名单只接受
  `shutdown-complete` / `ready` / `platform-session` / `fatal` / `update-tasks` / `quit-inspection`，
  发其他消息会被当作非法事件并杀掉 Host；preload 也没有暴露 restart/quit。所以必须从进程外部重启。
- 插件的 Host 半身（`host/index.js`）在 `GET /dsh-app-restart/status` 与
  `POST /dsh-app-restart/restart` 上提供接口；Client 半身（`client/client.js`）只发同源 `fetch`。
  写操作要求 loopback 对端 + loopback `Host` 头 + 同源 `Origin`；桌面窗口经 Electron 协议处理器
  转发时这些头会被剥掉，那条路径另要求一个自定义请求头（自定义头会强制 CORS 预检，而路由不响应预检），
  跨站页面无法伪造。
- Host 半身用 `process.execPath`（即 exe 路径）与 `process.ppid`（即 Electron 主进程 PID）
  确定重启目标，再通过 WMI 创建一个与自己进程树无关的启动器（父进程变成 `WmiPrvSE`），
  这样应用被杀掉时助手仍存活。
- 助手（`host/restart-helper.ps1`）先杀**整棵进程树**（只杀主进程会把 Desktop Host 和 renderer
  留成孤儿，它们占着 profile 锁和端口，而新实例会再起一个 Host），确认 PID 真正消失
  （单实例锁必须释放，否则新进程会立刻自杀），清掉从 Host 继承的
  `ELECTRON_RUN_AS_NODE` / `DSH_*` 等变量，再拉起同一个 exe。

### 关于「多余的控制台窗口」

早期版本重启后会弹出一个黑色的控制台窗口（里面是新实例 Host 的日志），关掉它整个应用也跟着退出了。
原因是 WMI 创建进程隐含 `CREATE_NEW_CONSOLE`：助手 powershell 拿到一个控制台，重新拉起的
Electron 继承了同一个控制台，于是它的日志出现在那扇窗里；点 × 会向该控制台上所有进程广播
`CTRL_CLOSE_EVENT`，主进程和 Host 一起退出。

现在链路上没有任何一环持有控制台：WMI 创建的是 GUI 子系统的 `wscript.exe`，
再由 VBScript 的 `WScript.Shell.Run(cmd, 0, False)` 以隐藏窗口、不等待的方式启动助手。
这与从桌面快捷方式启动的状态一致。主进程退出后由 `explorer.exe` 作为兜底拉起。

## 诊断

- 状态目录：`%TEMP%\dsh-app-restart\`
  - `last.json` —— 最近一次结果（`stage` 取值：`relaunched` / `dry-run` / `target-gone` /
    `target-mismatch` / `stop-failed` / `did-not-exit` / `launch-failed` / `launch-unconfirmed` /
    `launch-exited`），失败时页面按钮会显示该 `stage`。
  - `helper.log` —— 逐阶段日志。
- 想只看不动手：`POST /dsh-app-restart/restart` 带 `{"dryRun":true}`，助手会校验目标后停下。
- 按钮在 20 秒内没等到应用退出，会自动回到可点击状态并显示失败阶段，不会一直转圈。

## 目录结构

```
package.json              包清单：dsh.bundle.patch + dsh.client（根上必须有）
lib/index.js              Host 半身：路由、WMI 启动器、状态读取
lib/restart-helper.ps1    独立助手：整树终止、等待退出、清理环境、重新拉起
client.js                 Client 半身：侧边栏底部的「刷新」「重启」
cordis.patch.yml          插入一行 Host 插件
locale/{en,zh}.json       市场卡片标题与描述
icon.svg                  包内图标；assets/icon-180.png 与 icon-640.png 供列表页使用
.github/workflows/verify.yml CI：manifest、包内容、语法、patch 行校验
```

## 限制

- 仅 Windows 桌面版可用（Linux/macOS 下按钮显示为不可用）。
- 重启是一次干净的整进程重启：正在运行的 agent 回合、后台任务会随进程一起中断。

## 许可证

MIT
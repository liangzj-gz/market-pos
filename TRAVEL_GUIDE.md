# 出差调试指南（iPad / 手机，不依赖 Mac）

> 适用场景：Mac 断电、断网、留在家中不带出门时的远程需求修改与调试。

---

## 一、两个地址（背下来）

| 用途 | 地址 |
|---|---|
| **调试预览**（免登录，看全部界面） | `https://liangzj-gz.github.io/market-pos/?preview=1` |
| 仓库（改代码） | `https://github.com/liangzj-gz/market-pos` |

预览地址已配置 PWA：用 Safari 打开 → 分享 → **添加到主屏幕**，之后像 App 一样全屏运行。

---

## 二、完整闭环（3 步，全程不用碰代码）

> ✅ **已实测通过**（2026-10-21 手机端实测：App 顶栏显示「liangzj的MacBook Air」，消息正常送达并在 Mac 上执行）
> 前提：**Mac 在线**。所有改码动作由 Mac 上的 WorkBuddy 执行，你只需要用中文把需求说出来。

### 1. 说需求

iPad 上装 WorkBuddy App（App Store 搜「WorkBuddy」），用**和电脑端同一个账号**登录 →
侧边栏选「连接电脑」→ 连上家里的 Mac → 像平时对话一样说，例如：

> 把开单页的主按钮从蓝色改成橙色，另外库存不足时按钮置灰

### 2. 等它做完

Mac 上的 WorkBuddy 会自动：读代码 → 改代码 → 提交并推送到 GitHub → 触发自动部署。
约 1 分钟，可在 `https://github.com/liangzj-gz/market-pos/actions` 看进度。

> 若你还要更新**正式线上地址**，补一句「也发布到 WorkBuddy 正式站」，agent 会顺带触发桌面端「发布为应用」。
> （注意：`git push` 只更新预览站，正式站必须显式发布。）

> 项目根目录的 **`AGENTS.md`** 写明了完整流程（语法自检 → commit → push → 部署），
> agent 读完就知道该怎么收尾，你也可以直接说「按 AGENTS.md 的流程走完」。

### 3. 看效果

回到预览地址刷新（Safari 下拉刷新）。如果看到旧版本，换个参数绕过缓存：
`https://liangzj-gz.github.io/market-pos/?preview=1&v=2`

---

## 三、想重新部署某个旧版本？

Actions 页面 → 找到对应 run → 右侧 **Re-run all jobs**。或用 `workflow_dispatch` 手动触发。

---

## 四、能力边界（务必清楚）

| 能做 | 不能做 |
|---|---|
| 用中文提需求，让 Mac 上的 WorkBuddy 改任意界面/交互/样式/文案 | Mac 离线 /「连接电脑」连不上时的任何代码改动 |
| 调试全部 8 个页面（今日/开单/订单/库存/预警/商品/统计/设置） | 真实手机号登录 |
| 提交、推送、看部署结果 | 云端真实数据的读写与同步 |
| 回退任意历史版本 | —— |
| **把改动发布到正式线上地址**（前提：Mac 在线且「连接电脑」已连上；需明确说「发布到 WorkBuddy 正式站」，由 Mac 上的 WorkBuddy 触发「发布为应用」） |  |

**关于两个线上地址**（很重要）：

- **预览站** `https://liangzj-gz.github.io/market-pos/?preview=1`：走纯本地数据（29 笔种子订单），不碰云端。随 `git push origin main` **自动部署**（约 1 分钟），不用额外动作。
- **正式站** `https://market-pos-90848.app.workbuddy.host/?sharecode=PUCYQVFTVK`：绑定 WorkBuddy 平台域名，发布通道只能在 **Mac 的 WorkBuddy 桌面端**触发，且**不会**随 git push 自动更新。

**结论**：只要 Mac 在线、「连接电脑」连得上，你在手机上提的需求，agent 既能改代码 + 推到预览站，也能顺手「发布到正式站」——因为「连接电脑」本质就是远程操作那台 Mac 的桌面端。唯一要点：**git push 不会更新正式站**，必须明确告诉 agent「改完之后也发布到 WorkBuddy 正式站」。

**推荐话术**（手机上说一句即可）：

> 按 AGENTS.md 的流程走：改完代码 → 语法自检 → git push（更新预览站）→ 发布到 WorkBuddy 正式站（更新正式站）。

如果某次没让 agent 发布，也没关系：回 Mac 后 `git pull` 拉回改动，再点一次「发布为应用」即可补上，两个地址就同步了。

---

## 五、应急方案

| 情况 | 处置 |
|---|---|
| GitHub Pages 打不开 | 检查 `https://github.com/liangzj-gz/market-pos/actions` 是否部署成功；失败可点 Re-run |
| 手机连不上电脑 | ① 确认两端网络都通；② 确认手机 App 登录的账号与电脑端**完全一致**（微信账号必须相同）；③ 确认桌面端「连接移动端」开关已打开；④ 确认 Mac 没休眠 |
| Mac 突然断电断网 | 无法补救，当天只能记录需求，回家再改。出发前按第六节把 Mac 设为不易休眠 |
| 预览页显示旧版 | Safari 强制刷新：长按刷新键，或用 `?preview=1&v=<数字>` 换参数 |

---

## 六、给 Mac 的准备（出门前必做，这决定你路上能不能用）

1. **打开「连接移动端」**：WorkBuddy 侧边栏底部图标 → 「允许移动端连接此设备」
2. **打开「允许锁屏运行」**：同一面板里勾上，或到系统设置 → 通用 → 允许锁屏运行
3. **防止自动休眠**，在终端执行（合盖也不睡）：
   ```bash
   caffeinate -s &
   ```
   想更彻底（需要管理员密码）：
   ```bash
   sudo pmset -a sleep 0 disksleep 0
   ```
4. **断电后能自动开机**（需要管理员密码，防的是家里跳闸/断电）：
   ```bash
   sudo pmset autorestart 1
   ```
5. 确认仓库已推送干净：`cd ~/WorkBuddy/集市收银台 && git status` 显示 `working tree clean`
6. 确认线上正式地址已是最新版本（用 WorkBuddy 发布一次）

> ✅ **推送已配 SSH 免密**：远程仓库地址为 `git@github.com:liangzj-gz/market-pos.git`，
> agent 直接 `git push origin main` 即可，**不依赖任何 token、不弹密码框、不会卡住**。
> （请勿改回 https 地址；之前给的 PAT 出差回来后可删。）

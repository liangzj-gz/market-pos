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

> 前提：**Mac 在线**。所有改码动作由 Mac 上的 WorkBuddy 执行，你只需要用中文把需求说出来。

### 1. 说需求

iPad 上装 WorkBuddy App（App Store 搜「WorkBuddy」），用**和电脑端同一个账号**登录 →
侧边栏选「连接电脑」→ 连上家里的 Mac → 像平时对话一样说，例如：

> 把开单页的主按钮从蓝色改成橙色，另外库存不足时按钮置灰

### 2. 等它做完

Mac 上的 WorkBuddy 会自动：读代码 → 改代码 → 提交并推送到 GitHub → 触发自动部署。
约 1 分钟，可在 `https://github.com/liangzj-gz/market-pos/actions` 看进度。

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
| 用中文提需求，让 Mac 上的 WorkBuddy 改任意界面/交互/样式/文案 | Mac 离线时的任何代码改动 |
| 调试全部 8 个页面（今日/开单/订单/库存/预警/商品/统计/设置） | 真实手机号登录 |
| 提交、推送、看部署结果 | 云端真实数据的读写与同步 |
| 回退任意历史版本 | 把改动发布到**正式**线上地址 |

**原因**：正式上线的发布通道绑定 WorkBuddy 平台域名，只能在 Mac 桌面端触发。预览地址因为带 `?preview=1` 走的是纯本地数据（29 笔种子订单），不碰云端。

**衔接方式**：出差期间所有改动都在 GitHub 仓库里。回 Mac 后：

```bash
cd ~/WorkBuddy/集市收银台
git pull          # 拉回 iPad 上的改动
```

然后在 WorkBuddy 里点一次「发布为应用」，正式线上地址即可同步到最新。

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

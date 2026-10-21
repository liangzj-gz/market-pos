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

## 二、完整闭环（4 步）

### 1. 改代码

iPad Safari 打开：

```
https://vscode.dev/github.com/liangzj-gz/market-pos
```

首次会要求登录 GitHub（用你 `liangzj-gz` 的账号），授权后即可在 iPad 上直接编辑 `src/` 下的文件。

### 2. 提交

- vscode.dev 左下角 → **源代码管理** 图标
- 输入提交信息（如 `调整开单页布局`）→ 点 ✓ **提交**
- 然后点 **推送（Push）**（如果界面要求选分支，选 `main`）

### 3. 等部署

push 后 GitHub Actions 自动部署，约 **1 分钟**。
进度可看：`https://github.com/liangzj-gz/market-pos/actions`

### 4. 看效果

回到预览地址刷新（Safari 下拉刷新）。如果看到旧版本，强制刷新一次或加个参数绕过缓存：
`https://liangzj-gz.github.io/market-pos/?preview=1&v=2`

---

## 三、想重新部署某个旧版本？

Actions 页面 → 找到对应 run → 右侧 **Re-run all jobs**。或用 `workflow_dispatch` 手动触发。

---

## 四、能力边界（务必清楚）

| 能做 | 不能做 |
|---|---|
| 修改任意界面、交互、样式、文案 | 真实手机号登录 |
| 调试全部 8 个页面（今日/开单/订单/库存/预警/商品/统计/设置） | 云端真实数据的读写与同步 |
| 提交、推送、看部署结果 | 把改动发布到**正式**线上地址 |
| 回退任意历史版本 | 改动正式线上环境 |

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
| iPad 上 vscode.dev 打不开 | 换 Chrome 浏览器；或用 GitHub 网页版直接编辑单个文件 |
| 想改代码但完全不想用 GitHub | 回家后在 Mac 上用 WorkBuddy 改，改完 `git push` 即可 |
| 预览页显示旧版 | Safari 强制刷新：长按刷新键，或用 `?preview=1&v=<数字>` 换参数 |

---

## 六、给 Mac 的准备（出门前做）

1. 确认仓库已推送干净：`git status` 应显示 `working tree clean`
2. 确认线上正式地址已是最新版本（用 WorkBuddy 发布一次）
3. 若要保险，可给 Mac 设一个不自动休眠的定时任务（回家后仍在跑）：
   ```bash
   caffeinate -s &
   ```

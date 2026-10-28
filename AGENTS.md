# AGENTS.md — 集市收银台（摆摊订单管家）协作说明

> 本文件写给**任何在本项目上工作的 AI agent**，包括通过手机远程操控本机的 WorkBuddy。
> 读完请严格按下面的流程做，不要只改完代码就停下。

## 项目是什么

- **纯静态前端**，无构建步骤、无 npm、无打包。`index.html` 里用 `<script type="module">` 直接加载 `src/app.js`
- 技术栈：Vue 3 全局版（`assets/vendor/vue.global.prod.js`）+ 原生 ES module + Tailwind 风格的静态 CSS（`assets/css/*.css`）
- 目录结构：
  - `src/app.js` — 应用外壳：登录门禁、导航、hash 路由、全局抽屉与提示层
  - `src/data/store.js` — 响应式数据仓库（`store` / `act()` / `bootstrap()`），所有业务状态都在这
  - `src/data/seed.js` — 种子数据（29 笔订单、36 商品、7 条预警等）
  - `src/data/cloud.js` + `src/cloud-config.js` — WorkBuddy 云服务数据层
  - `src/views/*.js` — 8 个页面：today / register / orders / inventory / alerts / catalog / stats / settings
  - `src/components/*.js` — 通用组件与图标
  - `src/domain/*.js`、`src/util/format.js` — 领域逻辑与格式化
- 视图切换靠 `store.ui.view` + hash 路由（`#/today` 这类）

## 改完代码后必须做的事（不要省略）

1. **语法自检**（避免整个页面白屏）：
   ```bash
   cd ~/WorkBuddy/集市收银台
   for f in src/app.js src/data/store.js src/data/seed.js src/data/cloud.js; do
     cp "$f" /tmp/_chk.mjs && node --check /tmp/_chk.mjs || echo "语法错误: $f"
   done
   ```
2. **提交并推送**（远程已配置为 SSH 免密，直接推，不会要密码、不会弹任何提示）：
   ```bash
   git add -A && git commit -m "简要描述本次改动" && git push origin main
   ```
   remote 为 `git@github.com:liangzj-gz/market-pos.git`，SSH 密钥已注册在账号 `liangzj-gz` 下，
   推送**不依赖任何 token**，请勿改回 https 地址。
3. **告知用户预览地址**：push 后约 1 分钟自动部署完成，用户刷新
   `https://liangzj-gz.github.io/market-pos/?preview=1` 即可看到效果
   （若看到旧版本，让用户在网址后加 `&v=2` 之类参数强制刷新缓存）

## 重要约束

- **`?preview=1` 是免登录调试模式**：`src/data/store.js` 里的 `PREVIEW` 常量检测 URL 参数后跳过云端登录、直接灌种子数据。**不要删掉这个分支**，它是外出调试和线上预览的唯一入口。
- **不要修改 `src/cloud-config.js`**：里面的 `endpoint` / `publishableKey` 是线上正式环境的云服务配置，绑定 `market-pos-90848.app.workbuddy.host`，服务端会做 Origin 校验。改了就登不上。
- **正式上线不是 `git push`**：正式地址由 WorkBuddy 桌面端「发布为应用」触发，`git push` 只会更新 GitHub Pages 预览站。两者互不影响，各自独立。
- **仓库是 public**（因为免费账号的 GitHub Pages 只支持公开仓库）。不要往里提交任何密钥、token、真实业务数据。`.workbuddy/` 已在 `.gitignore` 中排除。
- 改 UI 优先改 `assets/css/views.css` 里的既有类名，遵循现有设计令牌（`assets/css/tokens.css`），别硬写颜色值。

## 本地预览（Mac 上）

```bash
cd ~/WorkBuddy/集市收银台 && ./dev.sh
# 绑定 0.0.0.0，Cache-Control: no-store，启动时打印局域网地址
# 默认 8080；若被 ./testenv.sh 的 Docker 测试环境占用，会自动顺延到 8081、8082… 并提示实际端口
```
手机与 Mac 同一 Wi-Fi 时，用打印出来的局域网地址 + `?preview=1` 访问，改完刷新即生效（无需清缓存）。
注意 8080 若在跑 `./testenv.sh`，它服务的是 `dist` 打包快照，**不会随改代码更新**，预览要以 dev.sh 打印的端口为准。

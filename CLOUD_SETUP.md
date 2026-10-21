# 集市收银台 · WorkBuddy 云数据库接入规格

## 目标

把当前静态版（`web/`，数据在浏览器 localStorage）升级为 WorkBuddy 云应用：

- 手机号验证码登录（WorkBuddy 内置身份认证）
- 数据按账号隔离，换设备登录后看到同一份数据
- 保留现有 Vue 界面和 `web/src/domain/rules.js` 的全部业务规则
- 首次登录云端无数据时，用 `web/src/data/seed.js` 的 29 笔历史订单初始化

不要重写业务规则，也不要把规则翻译成 SQL。规则继续在前端执行，云端只负责存取整份数据。

## 数据模型：单行 JSONB + 乐观并发

一份数据对应一个登录用户，存成一行 JSONB，形状与 `web/src/data/store.js` 里的 `store.db` 完全一致（products / categories / tags / combos / orders / orderItems / adjustments / balances / movements / alerts / seq）。

```sql
create table if not exists public.app_state (
  owner_id text primary key default auth.uid(),
  version bigint not null default 0,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "app_state_own" on public.app_state;
create policy "app_state_own" on public.app_state
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create or replace function public.save_state(p_version bigint, p_doc jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid text := auth.uid();
  v_new bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.app_state
     set version = version + 1,
         doc = p_doc,
         updated_at = now()
   where owner_id = v_uid
     and version = p_version
  returning version into v_new;

  if v_new is null and p_version = 0 then
    insert into public.app_state (owner_id, version, doc, updated_at)
    values (v_uid, 1, p_doc, now())
    on conflict (owner_id) do nothing
    returning version into v_new;
  end if;

  if v_new is null then
    return null; -- 版本冲突，客户端重新拉取
  end if;

  return jsonb_build_object('version', v_new);
end;
$$;

grant execute on function public.save_state(bigint, jsonb) to authenticated;
```

## 前端改造

### 1. 引入 SDK

把 WorkBuddy Cloud SDK 作为本地脚本放在 `assets/vendor/workbuddy-cloud-sdk.js`（已放好），在 `index.html` 的 `src/app.js` 之前加载：

```html
<script src="./assets/vendor/workbuddy-cloud-sdk.js"></script>
<script type="module" src="./src/app.js"></script>
```

### 2. 配置文件

新增 `web/src/cloud-config.js`，由 WorkBuddy 云服务激活结果填入：

```js
export const cloudConfig = {
  endpoint: 'https://<应用域名>',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_<...>'
};
```

`endpoint` 必须和新应用发布后的域名一致（WorkBuddy 会做 Origin 校验）。

### 3. 云端数据层

新增 `web/src/data/cloud.js`：

- `createWorkBuddyCloud({ endpoint, oauthRelayBaseUrl, publishableKey })`
- `getSession()` / `sendOtp({ phone })` / `verifyOtp(...)` / `signOut()`
- `loadState()`：`from('app_state').select('version,doc').limit(1)`
- `saveState(version, doc)`：`rpc('save_state', { p_version: version, p_doc: doc })`
- 返回 null 表示版本冲突，重新 `loadState()` 后提示用户重试

### 4. store.js

保留现有的 `store` / `selectors` / `actions` 形状，只替换持久化：

- 启动时先检查登录状态；未登录显示登录页
- 登录后 `loadState()`；没有行时 `buildSeedDb()`，用 `version: 0` 调 `saveState`
- `act(fn)` 仍然同步执行业务规则并更新 `store.db`，然后 300ms 防抖调用 `saveState`
- 保存成功更新 `store.version` 和同步状态；冲突时重新拉取并提示「数据已在其他设备更新，请重试刚才的操作」
- 网络失败时保留本地修改并显示「未同步」，不要让页面白屏
- `actions.exportJson` 继续可用；`actions.importJson` 导入后也要走 `saveState`
- 移除「演示数据 / 本机数据」文案，改成「云端同步」和当前登录手机号

### 5. 登录页

新增 `web/src/views/login.js`：

- 手机号 + 6 位验证码
- 「获取验证码」倒计时 60 秒
- 登录成功后进入应用；退出登录清空当前内存数据
- 复用现有 CSS 变量和按钮样式，移动端单列布局

## 发布

1. 在 WorkBuddy 新建/绑定应用，开通「云数据库」和「身份认证」。
2. 用上面的 SQL 建表、开 RLS、建 `save_state` 函数。
3. 把云服务返回的 `endpoint`、`publishableKey` 填进 `web/src/cloud-config.js`。
4. 发布 `web/` 为网站应用，确保新应用域名与 `endpoint` 完全一致。
5. 用手机号登录一次，确认：
   - 首次登录自动写入 29 笔历史订单
   - 开单/收款后刷新页面数据仍在
   - 换一个浏览器登录同一手机号能看到同一份数据
   - 未登录直接访问接口返回未授权

## 验收底线

- 云端是唯一数据源；localStorage 只能做临时缓存，不能作为最终存储
- 两个页面同时操作时，后保存者收到冲突提示并刷新，不得静默覆盖
- 不在前端硬编码数据库密钥；只使用 WorkBuddy 云服务返回的 publishableKey

/* ============================================================
   云服务配置

   这里的三个值来自 WorkBuddy 云服务激活结果（publicConfig），
   可以放在前端源码里：publishableKey 只标识「哪个应用」，
   本身不带任何权限，服务端还会校验 Origin。
   真正的环境 ID 和数据库密钥留在服务端，永远不会下发到浏览器。
   ============================================================ */

export const cloudConfig = {
  endpoint: 'https://market-pos-90848.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_guTvZWDoSjTuFs6rthM30K_A0C7wQyC5zNcWgLvJb1UoDOshF04tQ9H'
};

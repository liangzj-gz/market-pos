-- 0010_placeholder.sql —— 迁移机制占位示例（可安全删除或留作模板）
-- 说明：
--  * 首次部署：postgres 容器 entrypoint 已执行 0000-0003 建库；本目录脚本由 API 启动时
--    按 schema_migrations 记录补跑（未跑过的）。
--  * 以后每次调整表结构：在本目录新增 00NN_描述.sql（必须幂等：
--    CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DO $$ BEGIN ... EXCEPTION ... END $$）。
--  * 脚本里不要写 GRANT/REVOKE（自托管 API 即库属主）。

SELECT 1;

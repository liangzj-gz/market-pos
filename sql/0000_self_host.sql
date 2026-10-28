-- ============================================================
-- 0000_self_host.sql —— 自托管兼容层（Oracle Cloud / 任意 PostgreSQL 12+）
-- ------------------------------------------------------------
-- docker-compose 的 postgres 容器会把 ./sql 挂到 docker-entrypoint-initdb.d，
-- 按文件名顺序执行：0000（本文件）→ 0001 → 0002 → 0003。
-- 云端专用脚本在 sql/cloud/（0004 授权收口、0010 迁移），自托管不执行。
-- 本文件安全前提：数据库仅供本应用使用，API 是唯一入口，API 连接角色
-- 既是表属主也是函数调用者（POSTGRES_USER=数据库属主）。
-- ============================================================

-- 1) auth schema：auth.uid() 读当前会话的 app.uid 自定义配置
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT NULLIF(current_setting('app.uid', true), '')::text $$;

-- 2) 本地账号表（API 层管理，与业务表隔离）
CREATE TABLE IF NOT EXISTS local_users (
  id            bigserial PRIMARY KEY,
  phone         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 3) 业务函数的执行授权（API 连接角色是属主，天然可执行）
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;

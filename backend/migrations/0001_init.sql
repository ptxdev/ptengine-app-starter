-- 0001_init.sql
--
-- ⚠️ Migration 的三条硬约定（平台侧 Migrator 的行为决定的，不是建议）：
--
--   1. **只进不退。** 版本回滚只回滚代码，**不回滚 schema** —— 自动回滚 schema 会丢数据。
--   2. **已发布的文件不要改。** 平台按文件名序号记录"已应用到哪一版"，改旧文件不会重跑。
--      要改就加一个新序号的文件。
--   3. **必须可重复安全执行。** 用 `IF NOT EXISTS`，别假设只跑一次。
--
-- 文件名必须是 `NNNN_描述.sql`，序号连续不跳号（`ptx package` 会校验）。

CREATE TABLE IF NOT EXISTS settings (
    sid        TEXT PRIMARY KEY,   -- 站点 id，来自已验签的 token（ctx.auth.sid）
    currency   TEXT NOT NULL DEFAULT 'USD',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

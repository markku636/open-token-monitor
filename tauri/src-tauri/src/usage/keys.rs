//! tokscale 各版本、各 client 用過的欄位名稱。原樣抄自上游 src/shared/usage.js，
//! 順序有意義（`first_number` 取第一個非 0 的鍵），不要排序或去重。

pub const TOKEN_KEYS: &[&str] = &[
    "totalTokens",
    "total_tokens",
    "totalTokenCount",
    "total_token_count",
    "tokens",
    "tokenCount",
    "token_count",
];

/// token 總量的加法成分。`reasoning` 刻意不在這裡：多數 client 的 reasoning 已含在 output 裡，
/// 只有 `DISJOINT_REASONING_CLIENTS` 另外加。
pub const TOKEN_COMPONENT_KEYS: &[&str] = &[
    "input",
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "output",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "cacheRead",
    "cacheReadTokens",
    "cache_read_tokens",
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write_tokens",
    "cachedTokens",
    "cached_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "totalInput",
    "totalOutput",
    "totalCacheRead",
    "totalCacheWrite",
];

pub const COST_KEYS: &[&str] = &[
    "costUsd",
    "cost_usd",
    "costUSD",
    "cost",
    "totalCost",
    "total_cost",
];
pub const MESSAGE_COUNT_KEYS: &[&str] = &[
    "messageCount",
    "message_count",
    "messages",
    "totalMessages",
    "total_messages",
];
pub const SESSION_ID_KEYS: &[&str] = &[
    "sessionId",
    "session_id",
    "session",
    "conversationId",
    "conversation_id",
    "threadId",
    "thread_id",
];
pub const INPUT_TOKEN_KEYS: &[&str] = &[
    "input",
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "totalInput",
];
pub const OUTPUT_TOKEN_KEYS: &[&str] = &[
    "output",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalOutput",
];
pub const CACHE_READ_TOKEN_KEYS: &[&str] = &[
    "cacheRead",
    "cacheReadTokens",
    "cache_read_tokens",
    "cachedTokens",
    "cached_tokens",
    "cacheReadInputTokens",
    "totalCacheRead",
];
pub const CACHE_WRITE_TOKEN_KEYS: &[&str] = &[
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheCreationInputTokens",
    "totalCacheWrite",
];
pub const REASONING_TOKEN_KEYS: &[&str] = &["reasoning", "reasoningTokens", "reasoning_tokens"];
/// tokscale 每列的 `performance` 區塊。`msPer1KTokens` 刻意不讀：它是除過的比例，跨列相加沒有意義。
pub const TIMED_DURATION_KEYS: &[&str] = &[
    "totalDurationMs",
    "total_duration_ms",
    "timedDurationMs",
    "timed_duration_ms",
];
pub const TIMED_TOKEN_KEYS: &[&str] = &["timedTokens", "timed_tokens"];
pub const STARTED_AT_KEYS: &[&str] = &["startedAt", "started_at", "createdAt", "created_at"];
pub const LAST_USED_AT_KEYS: &[&str] = &[
    "lastUsedAt",
    "last_used_at",
    "updatedAt",
    "updated_at",
    "lastActivityAt",
    "last_activity_at",
    "timestamp",
];

/// `detectClient` 依序查看的欄位。
pub const CLIENT_FIELDS: &[&str] = &[
    "client", "clients", "source", "platform", "agent", "tool", "name",
];
/// `detectModel` 依序查看的欄位。
pub const MODEL_FIELDS: &[&str] = &["model", "modelName", "model_name", "deployment", "engine"];
/// `looksLikeUsageRow` 需要至少一個 truthy 的欄位（外加 session id）。
pub const ROW_HINT_FIELDS: &[&str] = &[
    "client", "clients", "source", "platform", "agent", "tool", "model", "provider", "date", "name",
];

/// tokscale 對這些 client 輸出互斥的 output / reasoning（history.js `TOKSCALE_DISJOINT_REASONING_CLIENTS`）。
pub const DISJOINT_REASONING_CLIENTS: &[&str] = &["reasonix", "codex", "droid", "dsh"];

pub const REASONIX_CLIENT: &str = "reasonix";

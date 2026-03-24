// Copyright 2026
// SPDX-License-Identifier: Apache-2.0
//
// Redis backend for the rate limiter engine.
//
// Holds a lazily-created multiplexed async Redis connection.
// Fires the same batch Lua scripts as the Python RedisBackend — one EVAL call
// per evaluate_many() invocation regardless of dimension count (REDIS-01/03).
//
// Key format: `{prefix}:{dimension_key}:{window_seconds}`
// This matches the Python RedisBackend key format exactly so that instances
// running the Rust backend and instances running the Python fallback share the
// same Redis counters during a rolling upgrade.

use std::cmp::max;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use redis::aio::MultiplexedConnection;
use tokio::runtime::{Builder, Runtime};

use crate::config::Algorithm;
use crate::types::DimResult;

// ---------------------------------------------------------------------------
// Batch Lua scripts — identical to Python RedisBackend._LUA_BATCH_* constants
// ---------------------------------------------------------------------------

const LUA_BATCH_FIXED: &str = r#"
local results = {}
for i = 1, #KEYS do
    local current = redis.call('INCR', KEYS[i])
    if current == 1 then
        redis.call('EXPIRE', KEYS[i], ARGV[i])
    end
    local ttl = redis.call('TTL', KEYS[i])
    results[i] = {current, ttl}
end
return results
"#;

const LUA_BATCH_SLIDING: &str = r#"
local now = tonumber(ARGV[1])
local results = {}
for i = 1, #KEYS do
    local base = 1 + (i-1)*3 + 1
    local window = tonumber(ARGV[base])
    local limit  = tonumber(ARGV[base+1])
    local member = ARGV[base+2]
    local cutoff = now - window
    redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', cutoff)
    local count = tonumber(redis.call('ZCARD', KEYS[i]))
    redis.call('EXPIRE', KEYS[i], window + 1)
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local oldest_ts = 0
    if #oldest > 0 then oldest_ts = tonumber(oldest[2]) end
    if count >= limit then
        results[i] = {0, count, oldest_ts}
    else
        redis.call('ZADD', KEYS[i], now, member)
        count = count + 1
        oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
        oldest_ts = 0
        if #oldest > 0 then oldest_ts = tonumber(oldest[2]) end
        results[i] = {1, count, oldest_ts}
    end
end
return results
"#;

const LUA_BATCH_TOKEN_BUCKET: &str = r#"
local now = tonumber(ARGV[1])
local results = {}
for i = 1, #KEYS do
    local base = 1 + (i-1)*2 + 1
    local capacity = tonumber(ARGV[base])
    local rate = tonumber(ARGV[base+1])
    local data = redis.call('HMGET', KEYS[i], 'tokens', 'last_refill')
    local tokens = tonumber(data[1])
    local last_refill = tonumber(data[2])
    if tokens == nil then
        tokens = capacity - 1
        redis.call('HSET', KEYS[i], 'tokens', tokens, 'last_refill', now)
        local ttl = math.ceil(capacity / rate) + 1
        redis.call('EXPIRE', KEYS[i], ttl)
        results[i] = {1, math.floor(tokens), 0}
    else
        local elapsed = now - last_refill
        tokens = math.min(capacity, tokens + elapsed * rate)
        local allowed, time_to_next
        if tokens >= 1.0 then
            tokens = tokens - 1.0
            allowed = 1
            time_to_next = 0
        else
            allowed = 0
            time_to_next = math.ceil((1.0 - tokens) / rate)
        end
        redis.call('HSET', KEYS[i], 'tokens', tokens, 'last_refill', now)
        local ttl = math.ceil((capacity - tokens) / rate) + 1
        redis.call('EXPIRE', KEYS[i], ttl)
        results[i] = {allowed, math.floor(tokens), time_to_next}
    end
end
return results
"#;

// ---------------------------------------------------------------------------
// Unique member counter for sliding window sorted sets
// ---------------------------------------------------------------------------

static MEMBER_CTR: AtomicU64 = AtomicU64::new(0);

fn unique_member(now: f64) -> String {
    let n = MEMBER_CTR.fetch_add(1, Ordering::Relaxed);
    format!("{:.6}:{}", now, n)
}

// ---------------------------------------------------------------------------
// Value extraction helpers
// ---------------------------------------------------------------------------

fn val_i64(v: &redis::Value) -> i64 {
    match v {
        redis::Value::Int(i) => *i,
        redis::Value::BulkString(b) => std::str::from_utf8(b)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

fn val_f64(v: &redis::Value) -> f64 {
    match v {
        redis::Value::Int(i) => *i as f64,
        redis::Value::BulkString(b) => std::str::from_utf8(b)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

fn inner_array(outer: &redis::Value, i: usize) -> Option<&Vec<redis::Value>> {
    match outer {
        redis::Value::Array(a) => match a.get(i) {
            Some(redis::Value::Array(inner)) => Some(inner),
            _ => None,
        },
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// RedisRateLimiter
// ---------------------------------------------------------------------------

pub struct RedisRateLimiter {
    client: redis::Client,
    conn: Mutex<Option<MultiplexedConnection>>,
    algorithm: Algorithm,
    prefix: String,
}

fn shared_runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime must initialise for Redis rate limiter")
    })
}

impl RedisRateLimiter {
    pub fn new(
        redis_url: &str,
        algorithm: Algorithm,
        prefix: String,
    ) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(redis_url)?;
        Ok(Self {
            client,
            conn: Mutex::new(None),
            algorithm,
            prefix,
        })
    }

    async fn connection_async(&self) -> Result<MultiplexedConnection, redis::RedisError> {
        {
            let conn_guard = self.conn.lock();
            if let Some(conn) = conn_guard.as_ref() {
                return Ok(conn.clone());
            }
        }

        let conn = self.client.get_multiplexed_tokio_connection().await?;
        let mut conn_guard = self.conn.lock();
        if let Some(existing) = conn_guard.as_ref() {
            return Ok(existing.clone());
        }
        *conn_guard = Some(conn.clone());
        Ok(conn)
    }

    fn reset_connection(&self) {
        *self.conn.lock() = None;
    }

    /// Evaluate all dimension checks in a single Redis EVAL call.
    ///
    /// `checks` is `(dimension_key, limit_count, window_nanos)` — same shape
    /// as the memory engine.  Returns one `DimResult` per check.
    pub fn evaluate_many(
        &self,
        checks: &[(String, u64, u64)],
        now_unix: i64,
    ) -> Result<Vec<DimResult>, redis::RedisError> {
        shared_runtime().block_on(self.evaluate_many_async(checks, now_unix))
    }

    pub async fn evaluate_many_async(
        &self,
        checks: &[(String, u64, u64)],
        now_unix: i64,
    ) -> Result<Vec<DimResult>, redis::RedisError> {
        if checks.is_empty() {
            return Ok(vec![]);
        }

        let now_float = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        let mut conn = self.connection_async().await?;
        let result = match self.algorithm {
            Algorithm::FixedWindow => self.eval_fixed(&mut conn, checks, now_unix).await,
            Algorithm::SlidingWindow => {
                self.eval_sliding(&mut conn, checks, now_float, now_unix).await
            }
            Algorithm::TokenBucket => {
                self.eval_token_bucket(&mut conn, checks, now_float, now_unix).await
            }
        };
        if result.is_err() {
            self.reset_connection();
        }
        result
    }

    fn redis_key(&self, dim_key: &str, window_nanos: u64) -> String {
        let window_secs = window_nanos / 1_000_000_000;
        format!("{}:{}:{}", self.prefix, dim_key, window_secs)
    }

    fn token_bucket_time_to_full(limit: u64, remaining: u64, window_nanos: u64) -> i64 {
        if remaining >= limit {
            return 0;
        }
        let window_secs = window_nanos as f64 / 1_000_000_000.0;
        let refill_rate = limit as f64 / window_secs;
        let tokens_needed = limit - remaining;
        max(1, (tokens_needed as f64 / refill_rate) as i64)
    }

    // --- Fixed window ---

    async fn eval_fixed(
        &self,
        conn: &mut MultiplexedConnection,
        checks: &[(String, u64, u64)],
        now_unix: i64,
    ) -> Result<Vec<DimResult>, redis::RedisError> {
        let keys: Vec<String> = checks
            .iter()
            .map(|(k, _, w)| self.redis_key(k, *w))
            .collect();
        let window_args: Vec<u64> = checks.iter().map(|(_, _, w)| w / 1_000_000_000).collect();

        let mut cmd = redis::cmd("EVAL");
        cmd.arg(LUA_BATCH_FIXED).arg(keys.len());
        for k in &keys {
            cmd.arg(k);
        }
        for w in &window_args {
            cmd.arg(w);
        }

        let raw: redis::Value = cmd.query_async(conn).await?;
        let mut results = Vec::with_capacity(checks.len());

        for (i, (_, limit, _)) in checks.iter().enumerate() {
            let inner = inner_array(&raw, i).ok_or_else(|| {
                redis::RedisError::from((redis::ErrorKind::TypeError, "expected inner array"))
            })?;
            let count = val_i64(inner.first().unwrap_or(&redis::Value::Int(0))) as u64;
            let ttl = val_i64(inner.get(1).unwrap_or(&redis::Value::Int(0)));
            let reset_timestamp = now_unix + ttl.max(0);

            if count > *limit {
                results.push(DimResult {
                    allowed: false,
                    limit: *limit,
                    remaining: 0,
                    reset_timestamp,
                    retry_after: Some(ttl.max(1)),
                });
            } else {
                results.push(DimResult {
                    allowed: true,
                    limit: *limit,
                    remaining: limit - count,
                    reset_timestamp,
                    retry_after: None,
                });
            }
        }
        Ok(results)
    }

    // --- Sliding window ---

    async fn eval_sliding(
        &self,
        conn: &mut MultiplexedConnection,
        checks: &[(String, u64, u64)],
        now_float: f64,
        now_unix: i64,
    ) -> Result<Vec<DimResult>, redis::RedisError> {
        let keys: Vec<String> = checks
            .iter()
            .map(|(k, _, w)| self.redis_key(k, *w))
            .collect();

        let mut cmd = redis::cmd("EVAL");
        cmd.arg(LUA_BATCH_SLIDING).arg(keys.len());
        for k in &keys {
            cmd.arg(k);
        }
        cmd.arg(now_float);
        for (_, limit, window_nanos) in checks {
            let window_secs = window_nanos / 1_000_000_000;
            cmd.arg(window_secs)
                .arg(*limit)
                .arg(unique_member(now_float));
        }

        let raw: redis::Value = cmd.query_async(conn).await?;
        let mut results = Vec::with_capacity(checks.len());

        for (i, (_, limit, window_nanos)) in checks.iter().enumerate() {
            let inner = inner_array(&raw, i).ok_or_else(|| {
                redis::RedisError::from((redis::ErrorKind::TypeError, "expected inner array"))
            })?;
            let allowed_int = val_i64(inner.first().unwrap_or(&redis::Value::Int(0)));
            let count = val_i64(inner.get(1).unwrap_or(&redis::Value::Int(0))) as u64;
            let oldest_ts = val_f64(inner.get(2).unwrap_or(&redis::Value::Int(0)));
            let window_secs = (window_nanos / 1_000_000_000) as f64;
            let reset_timestamp = (oldest_ts + window_secs) as i64 + 1;
            let reset_in = (reset_timestamp - now_unix).max(1);

            if allowed_int == 0 {
                results.push(DimResult {
                    allowed: false,
                    limit: *limit,
                    remaining: 0,
                    reset_timestamp,
                    retry_after: Some(reset_in),
                });
            } else {
                results.push(DimResult {
                    allowed: true,
                    limit: *limit,
                    remaining: limit.saturating_sub(count),
                    reset_timestamp,
                    retry_after: None,
                });
            }
        }
        Ok(results)
    }

    // --- Token bucket ---

    async fn eval_token_bucket(
        &self,
        conn: &mut MultiplexedConnection,
        checks: &[(String, u64, u64)],
        now_float: f64,
        now_unix: i64,
    ) -> Result<Vec<DimResult>, redis::RedisError> {
        let keys: Vec<String> = checks
            .iter()
            .map(|(k, _, w)| self.redis_key(k, *w))
            .collect();

        let mut cmd = redis::cmd("EVAL");
        cmd.arg(LUA_BATCH_TOKEN_BUCKET).arg(keys.len());
        for k in &keys {
            cmd.arg(k);
        }
        cmd.arg(now_float);
        for (_, limit, window_nanos) in checks {
            let window_secs = *window_nanos as f64 / 1_000_000_000.0;
            let rate = *limit as f64 / window_secs;
            cmd.arg(*limit).arg(rate);
        }

        let raw: redis::Value = cmd.query_async(conn).await?;
        let mut results = Vec::with_capacity(checks.len());

        for (i, (_, limit, window_nanos)) in checks.iter().enumerate() {
            let inner = inner_array(&raw, i).ok_or_else(|| {
                redis::RedisError::from((redis::ErrorKind::TypeError, "expected inner array"))
            })?;
            let allowed_int = val_i64(inner.first().unwrap_or(&redis::Value::Int(0)));
            let remaining = val_i64(inner.get(1).unwrap_or(&redis::Value::Int(0))) as u64;
            let time_to_next = val_i64(inner.get(2).unwrap_or(&redis::Value::Int(0)));

            if allowed_int == 0 {
                let reset_timestamp = now_unix + time_to_next.max(1);
                results.push(DimResult {
                    allowed: false,
                    limit: *limit,
                    remaining: 0,
                    reset_timestamp,
                    retry_after: Some(time_to_next.max(1)),
                });
            } else {
                let time_to_full =
                    Self::token_bucket_time_to_full(*limit, remaining, *window_nanos);
                let reset_timestamp = now_unix + time_to_full;
                results.push(DimResult {
                    allowed: true,
                    limit: *limit,
                    remaining,
                    reset_timestamp,
                    retry_after: None,
                });
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::RedisRateLimiter;

    #[test]
    fn token_bucket_success_reset_uses_time_to_full() {
        let window_nanos = 10_000_000_000_u64; // 10s
        let limit = 10_u64;
        let remaining = 9_u64;
        assert_eq!(
            RedisRateLimiter::token_bucket_time_to_full(limit, remaining, window_nanos),
            1
        );

        let remaining = 5_u64;
        assert_eq!(
            RedisRateLimiter::token_bucket_time_to_full(limit, remaining, window_nanos),
            5
        );
    }
}

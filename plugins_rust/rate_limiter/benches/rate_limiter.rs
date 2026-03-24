// Copyright 2026
// SPDX-License-Identifier: Apache-2.0
//
// Criterion benchmarks for the rate limiter memory backend.
// PERF-01, MEM-02, MEM-03, MEM-04.

use std::hint::black_box;
use std::sync::Arc;

use criterion::{Criterion, criterion_group, criterion_main};
use rate_limiter_rust::{
    clock::FakeClock,
    config::{Algorithm, EngineConfig, parse_rate},
    engine::RateLimiterEngine,
};

const T0_UNIX: i64 = 1_000_000;
const WINDOW: u64 = 1_000_000_000; // 1s

fn make_engine(algorithm: Algorithm) -> RateLimiterEngine {
    let (clock, _handle) = FakeClock::new(T0_UNIX);
    let cfg = EngineConfig {
        by_user: Some(parse_rate("1000000/s").unwrap()),
        by_tenant: None,
        by_tool: Default::default(),
        algorithm,
    };
    RateLimiterEngine::new_with_clock(cfg, Arc::new(clock))
}

fn bench_fixed_window(c: &mut Criterion) {
    let engine = make_engine(Algorithm::FixedWindow);
    c.bench_function("fixed_window/single_key", |b| {
        b.iter(|| {
            engine
                .evaluate_many(
                    black_box(vec![("user:bench".to_string(), 1_000_000, WINDOW)]),
                    T0_UNIX,
                )
                .unwrap()
        })
    });
}

fn bench_token_bucket(c: &mut Criterion) {
    let engine = make_engine(Algorithm::TokenBucket);
    c.bench_function("token_bucket/single_key", |b| {
        b.iter(|| {
            engine
                .evaluate_many(
                    black_box(vec![("user:bench".to_string(), 1_000_000, WINDOW)]),
                    T0_UNIX,
                )
                .unwrap()
        })
    });
}

fn bench_sliding_window(c: &mut Criterion) {
    let engine = make_engine(Algorithm::SlidingWindow);
    c.bench_function("sliding_window/single_key", |b| {
        b.iter(|| {
            engine
                .evaluate_many(
                    black_box(vec![("user:bench".to_string(), 1_000_000, WINDOW)]),
                    T0_UNIX,
                )
                .unwrap()
        })
    });
}

fn bench_multi_dim(c: &mut Criterion) {
    let engine = make_engine(Algorithm::FixedWindow);
    c.bench_function("fixed_window/three_dims", |b| {
        b.iter(|| {
            engine
                .evaluate_many(
                    black_box(vec![
                        ("user:alice".to_string(), 1_000_000, WINDOW),
                        ("tenant:acme".to_string(), 10_000_000, WINDOW),
                        ("tool:search".to_string(), 100_000, WINDOW),
                    ]),
                    T0_UNIX,
                )
                .unwrap()
        })
    });
}

criterion_group!(
    benches,
    bench_fixed_window,
    bench_token_bucket,
    bench_sliding_window,
    bench_multi_dim
);
criterion_main!(benches);

# Retrieval Evaluation Results

Dataset hash `9b42dc9b` · 200 tasks · seed 20260918 · split **eval** · OCC commit `094fcbb8692a` · working tree clean at run start: yes

## Overall (mean [95% bootstrap CI], per task)

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.305 [0.240, 0.370] | 0.371 [0.321, 0.420] | 0.478 [0.426, 0.529] | 0.255 [0.195, 0.320] | 0.449 [0.395, 0.504] |
| filename | 0.160 [0.110, 0.210] | 0.271 [0.217, 0.326] | 0.368 [0.311, 0.430] | 0.265 [0.205, 0.330] | 0.264 [0.219, 0.313] |
| bm25 | 0.255 [0.195, 0.315] | 0.359 [0.299, 0.413] | 0.481 [0.425, 0.536] | 0.310 [0.245, 0.375] | 0.396 [0.340, 0.447] |
| random | 0.000 [0.000, 0.000] | 0.007 [0.002, 0.015] | 0.009 [0.002, 0.017] | 0.000 [0.000, 0.000] | 0.016 [0.010, 0.022] |

OCC generated package: mean 27361 tokens, mean 8.0 files included per task.

## Source-only gold slice (OCC-fully-parsed gold)

Full gold: 524 gold files across 200 tasks. Source-only slice: 508 gold files across 200 tasks (0 tasks excluded for an empty slice).

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.305 [0.240, 0.370] | 0.380 [0.331, 0.430] | 0.489 [0.438, 0.539] | 0.270 [0.210, 0.335] | 0.449 [0.395, 0.504] |
| filename | 0.150 [0.105, 0.200] | 0.274 [0.219, 0.330] | 0.371 [0.312, 0.432] | 0.275 [0.215, 0.340] | 0.256 [0.211, 0.305] |
| bm25 | 0.250 [0.190, 0.310] | 0.355 [0.295, 0.411] | 0.474 [0.415, 0.527] | 0.310 [0.245, 0.375] | 0.384 [0.331, 0.438] |
| random | 0.000 [0.000, 0.000] | 0.005 [0.001, 0.011] | 0.007 [0.001, 0.013] | 0.000 [0.000, 0.000] | 0.014 [0.009, 0.021] |

## Package recall (gold coverage of the delivered answer)

OCC = fraction of gold files inside the generated package (parsed from its `### FILE:` headings); baselines = Recall@8, matching OCC's mean package size.

| System | Package recall (mean [95% CI]) |
|---|---|
| occ | 0.358 [0.310, 0.410] |
| filename | 0.340 [0.283, 0.397] |
| bm25 | 0.437 [0.382, 0.491] |
| random | 0.009 [0.002, 0.018] |

## Paired bootstrap: OCC − BM25 per-task differences

### Full gold

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.050 [-0.035, 0.130] | no |
| recall5 | 0.012 [-0.056, 0.078] | no |
| recall10 | -0.003 [-0.068, 0.057] | no |
| allGoldAcc10 | -0.055 [-0.120, 0.010] | no |
| mrr | 0.053 [-0.014, 0.125] | no |
| packageRecall | -0.079 [-0.144, -0.014] | **yes** |

### Source-only slice

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.055 [-0.035, 0.140] | no |
| recall5 | 0.026 [-0.039, 0.092] | no |
| recall10 | 0.015 [-0.046, 0.074] | no |
| allGoldAcc10 | -0.040 [-0.110, 0.030] | no |
| mrr | 0.065 [-0.010, 0.133] | no |
| packageRecall | -0.072 [-0.139, 0.000] | no |

## All-gold gap analysis (BM25 all-gold in top 10, OCC not)

29 tasks, 34 missing gold files. Missing by type: docs=4, source=15, test=15. Not in OCC's candidate set at all: 10. Median OCC rank of missing files: 28; median BM25 rank: 3.

- **axios:70302b6c9008**
  - lib/defaults/index.js (source): OCC rank 55, BM25 rank 8

- **axios:717f476b0f19**
  - README.md (docs): OCC rank 76, BM25 rank 2

- **fastify:16a74e7cb2d1**
  - test/content-parser.test.js (test): OCC rank 62, BM25 rank 9

- **fastify:628870555055**
  - test/404s.test.js (test): OCC rank 43, BM25 rank 8

- **fastify:897360ad9a01**
  - lib/contentTypeParser.js (source): OCC rank 26, BM25 rank 1

- **fastify:ad2da127e78b**
  - docs/Reference/Plugins.md (docs): OCC rank 36, BM25 rank 7
  - docs/Reference/Reply.md (docs): OCC rank 11, BM25 rank 3

- **fastify:edbb82035c6e**
  - test/reply-trailers.test.js (test): OCC rank 48, BM25 rank 1

- **hono:00f32b7c17e4**
  - src/client/client.test.ts (test): OCC rank 17, BM25 rank 6

- **hono:20d877167c8b**
  - src/jsx/intrinsic-elements.ts (source): OCC rank 37, BM25 rank 5

- **hono:879557f35fb7**
  - src/jsx/index.test.tsx (test): OCC rank 20, BM25 rank 5

- **hono:9cdfdf3c65af**
  - src/context.test.ts (test): OCC rank 13, BM25 rank 8

- **hono:d5e7da31132f**
  - src/request.ts (source): OCC rank 23, BM25 rank 3

- **hono:d9b8b4b73b4f**
  - src/middleware/cors/index.test.ts (test): OCC rank 33, BM25 rank 3

- **hono:ff715fca4bd5**
  - src/router/reg-exp-router/prepared-router.test.ts (test): OCC rank 16, BM25 rank 2

- **undici:0160a719063f**
  - lib/handler/retry-handler.js (source): OCC rank 13, BM25 rank 2
  - test/interceptors/retry.js (test): OCC rank not in candidates, BM25 rank 5

- **undici:0712f7d6f3bc**
  - test/env-http-proxy-agent.js (test): OCC rank 40, BM25 rank 3

- **undici:07276c90545b**
  - lib/core/symbols.js (source): OCC rank 14, BM25 rank 10

- **undici:69825dc1483d**
  - CONTRIBUTING.md (docs): OCC rank 55, BM25 rank 1
  - build/wasm.js (source): OCC rank not in candidates, BM25 rank 4

- **undici:7da8232df9fb**
  - lib/api/util.js (source): OCC rank 12, BM25 rank 3

- **undici:a4eaed1124ec**
  - lib/web/fetch/index.js (source): OCC rank not in candidates, BM25 rank 3

- **undici:ae18f0e7dade**
  - lib/web/websocket/receiver.js (source): OCC rank not in candidates, BM25 rank 3

- **undici:be564c1573f4**
  - lib/web/fetch/index.js (source): OCC rank not in candidates, BM25 rank 2
  - test/fetch/401-statuscode-no-infinite-loop.js (test): OCC rank not in candidates, BM25 rank 4

- **undici:d0399c40f116**
  - test/interceptors/dump-interceptor.js (test): OCC rank 72, BM25 rank 3

- **zod:599c0e41dccb**
  - packages/docs/components/ecosystem.tsx (source): OCC rank not in candidates, BM25 rank 2

- **zod:6407bed5a229**
  - deno/lib/__tests__/discriminated-unions.test.ts (test): OCC rank 27, BM25 rank 8
  - src/__tests__/discriminated-unions.test.ts (test): OCC rank 28, BM25 rank 7

- **zod:81d9fc6cf47d**
  - packages/docs/components/ecosystem.tsx (source): OCC rank not in candidates, BM25 rank 6

- **zod:cede2c63739a**
  - packages/zod/src/v4/classic/tests/tuple.test.ts (test): OCC rank not in candidates, BM25 rank 1

- **zod:d3da530deb71**
  - packages/zod/src/v4/core/schemas.ts (source): OCC rank 54, BM25 rank 5

- **zod:e06af5de314f**
  - packages/docs/components/ecosystem.tsx (source): OCC rank not in candidates, BM25 rank 6

## Per repository

### axios (pinned e6b79d9cef79, MIT)
Mined 2036, accepted 540, sampled 40, evaluated 40 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 11, non-localizable gold files excluded from accepted tasks: 83. Top rejections: bot-author=474, ci-only=117, docs-only=321, file-count=125, format-only=5.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.400 [0.250, 0.550] | 0.471 [0.343, 0.597] | 0.574 [0.463, 0.690] | 0.350 [0.200, 0.500] | 0.543 [0.415, 0.674] |
| filename | 0.200 [0.075, 0.325] | 0.283 [0.163, 0.399] | 0.362 [0.229, 0.491] | 0.250 [0.125, 0.375] | 0.284 [0.170, 0.409] |
| bm25 | 0.175 [0.075, 0.300] | 0.263 [0.158, 0.378] | 0.390 [0.276, 0.513] | 0.200 [0.075, 0.350] | 0.326 [0.223, 0.433] |
| random | 0.000 [0.000, 0.000] | 0.005 [0.000, 0.015] | 0.005 [0.000, 0.015] | 0.000 [0.000, 0.000] | 0.020 [0.008, 0.040] |

### fastify (pinned ce41dc0fbb4e, MIT)
Mined 4474, accepted 684, sampled 40, evaluated 40 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 1, non-localizable gold files excluded from accepted tasks: 114. Top rejections: bot-author=988, ci-only=237, docs-only=1010, file-count=133, format-only=21.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.275 [0.150, 0.400] | 0.318 [0.223, 0.418] | 0.393 [0.294, 0.490] | 0.150 [0.050, 0.275] | 0.442 [0.319, 0.558] |
| filename | 0.000 [0.000, 0.000] | 0.141 [0.064, 0.226] | 0.253 [0.158, 0.353] | 0.100 [0.025, 0.200] | 0.133 [0.088, 0.187] |
| bm25 | 0.200 [0.075, 0.325] | 0.314 [0.211, 0.426] | 0.431 [0.321, 0.547] | 0.225 [0.100, 0.375] | 0.361 [0.258, 0.474] |
| random | 0.000 [0.000, 0.000] | 0.017 [0.000, 0.042] | 0.017 [0.000, 0.042] | 0.000 [0.000, 0.000] | 0.020 [0.008, 0.036] |

### hono (pinned 5ca49b072075, MIT)
Mined 2803, accepted 1181, sampled 40, evaluated 40 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 4, non-localizable gold files excluded from accepted tasks: 158. Top rejections: bot-author=458, ci-only=101, docs-only=106, file-count=191, format-only=7.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.325 [0.200, 0.475] | 0.526 [0.411, 0.651] | 0.696 [0.574, 0.812] | 0.525 [0.375, 0.675] | 0.503 [0.396, 0.625] |
| filename | 0.200 [0.100, 0.325] | 0.415 [0.285, 0.559] | 0.643 [0.504, 0.772] | 0.600 [0.450, 0.750] | 0.325 [0.221, 0.436] |
| bm25 | 0.475 [0.300, 0.625] | 0.587 [0.450, 0.717] | 0.673 [0.535, 0.788] | 0.575 [0.400, 0.725] | 0.578 [0.448, 0.700] |
| random | 0.000 [0.000, 0.000] | 0.003 [0.000, 0.009] | 0.003 [0.000, 0.009] | 0.000 [0.000, 0.000] | 0.015 [0.003, 0.035] |

### undici (pinned 1f452240899a, MIT)
Mined 4353, accepted 1449, sampled 40, evaluated 40 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 2, non-localizable gold files excluded from accepted tasks: 305. Top rejections: bot-author=1101, ci-only=102, docs-only=210, file-count=166, format-only=6.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.175 [0.075, 0.300] | 0.179 [0.102, 0.265] | 0.288 [0.195, 0.386] | 0.100 [0.025, 0.200] | 0.307 [0.197, 0.419] |
| filename | 0.175 [0.075, 0.300] | 0.215 [0.108, 0.326] | 0.263 [0.151, 0.380] | 0.175 [0.075, 0.300] | 0.249 [0.140, 0.358] |
| bm25 | 0.325 [0.175, 0.475] | 0.448 [0.326, 0.578] | 0.512 [0.387, 0.641] | 0.325 [0.175, 0.475] | 0.462 [0.334, 0.591] |
| random | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.005 [0.001, 0.012] |

### zod (pinned afdac65e0f80, MIT)
Mined 2935, accepted 494, sampled 40, evaluated 40 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 8, non-localizable gold files excluded from accepted tasks: 70. Top rejections: bot-author=565, ci-only=128, docs-only=488, file-count=183, format-only=44.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.350 [0.200, 0.500] | 0.360 [0.260, 0.469] | 0.441 [0.343, 0.540] | 0.150 [0.050, 0.275] | 0.450 [0.321, 0.573] |
| filename | 0.225 [0.100, 0.350] | 0.300 [0.190, 0.423] | 0.318 [0.209, 0.438] | 0.200 [0.075, 0.325] | 0.329 [0.219, 0.454] |
| bm25 | 0.100 [0.025, 0.200] | 0.183 [0.094, 0.284] | 0.401 [0.281, 0.515] | 0.225 [0.100, 0.350] | 0.251 [0.176, 0.343] |
| random | 0.000 [0.000, 0.000] | 0.013 [0.000, 0.037] | 0.021 [0.000, 0.058] | 0.000 [0.000, 0.000] | 0.018 [0.005, 0.036] |

## Case studies (OCC)

### Worst 5 failures (lowest MRR)

- **hono:645b4f21eb2c** — MRR 0.000, Recall@10 0.000
  subject: fix(jsx/dom): Fixed to not give "px" for certain properties, even if numeric value is given (#2845)
  task: fix(jsx/dom): Fixed to not give "px" for certain properties, even if numeric value is given
  gold: src/jsx/utils.ts
  top-ranked: src/jsx/intrinsic-elements.ts, src/jsx/dom/index.test.tsx, src/adapter/aws-lambda/handler.ts, src/jsx/base.ts, src/jsx/dom/render.ts, src/jsx/jsx-runtime.ts, src/jsx/constants.ts, src/jsx/dom/index.ts, src/jsx/dom/utils.ts, src/adapter/aws-lambda/custom-context.ts

- **hono:9a6e52d734df** — MRR 0.000, Recall@10 0.000
  subject: feat(middleware/combine): Introduce combine middleware (#2941)
  task: feat(middleware/combine): Introduce combine middleware * feat(middleware/predicate): Introduce predicate middleware * fix: apply `bun run format:fix` * refactor: rename middleware predicate -> combine
  gold: jsr.json, package.json
  top-ranked: src/types.test.ts, src/utils/concurrent.ts, src/jsx/dom/render.ts, src/helper/ssg/ssg.ts, src/adapter/bun/websocket.ts, src/helper/streaming/sse.ts, src/helper/ssg/middleware.ts, src/adapter/bun/server.ts, runtime_tests/deno/middleware.test.tsx, src/types.ts

- **zod:50ef910565a1** — MRR 0.000, Recall@10 0.000
  subject: Add output type generic test
  task: Add output type generic test
  gold: packages/zod/src/v4/classic/tests/generics.test.ts, play.ts
  top-ranked: packages/zod/src/v3/types.ts, packages/zod/src/v3/tests/language-server.source.ts, packages/zod/src/v3/standard-schema.ts, packages/zod/src/v3/tests/tuple.test.ts, packages/zod/src/v3/ZodError.ts, packages/zod/src/v3/tests/standard-schema.test.ts, packages/zod/src/v3/tests/all-errors.test.ts, packages/zod/src/v3/tests/refine.test.ts, packages/zod/src/v3/tests/error.test.ts, packages/zod/src/v3/helpers/typeAliases.ts

- **zod:813451db7fcf** — MRR 0.000, Recall@10 0.000
  subject: v4.0.10 (#4978)
  task: v4.0.10 * Add discriminator to invalid_union. Closes * WIP * Closes * 4.0.10
  gold: packages/zod/jsr.json, packages/zod/package.json, packages/zod/src/v4/classic/tests/discriminated-unions.test.ts, packages/zod/src/v4/core/errors.ts, packages/zod/src/v4/core/schemas.ts, packages/zod/src/v4/core/versions.ts, play.ts
  top-ranked: packages/zod/src/v3/types.ts, packages/zod/src/v3/ZodError.ts, packages/zod/src/v3/tests/error.test.ts, packages/zod/src/v3/locales/en.ts, packages/zod/src/v4/locales/fi.ts, packages/zod/src/v3/helpers/parseUtil.ts, packages/zod/src/v4/locales/fr-CA.ts, packages/zod/src/v4/locales/fr.ts, packages/zod/src/v4/locales/en.ts, packages/zod/src/v4/locales/he.ts

- **zod:d3da530deb71** — MRR 0.000, Recall@10 0.000
  subject: reflect the specified regex correctly in error (#5338)
  task: reflect the specified regex correctly in error
  gold: packages/zod/src/v4/core/schemas.ts
  top-ranked: packages/zod/src/v3/types.ts, packages/zod/src/v4/core/api.ts, packages/zod/src/v4/classic/schemas.ts, packages/zod/src/v4/core/errors.ts, packages/zod/src/v4/core/regexes.ts, packages/zod/src/v4/locales/ar.ts, packages/zod/src/v4/locales/az.ts, packages/zod/src/v4/locales/be.ts, packages/zod/src/v4/locales/bg.ts, packages/zod/src/v4/locales/ca.ts

### Best 5 successes (highest MRR)

- **fastify:3b0f76993d51** — MRR 1.000, Recall@10 1.000
  subject: fix: anchor keyValuePairsReg to prevent quadratic backtracking (#6558)
  task: fix: anchor keyValuePairsReg to prevent quadratic backtracking
  gold: lib/content-type.js
  top-ranked: lib/content-type.js, lib/plugin-utils.js, lib/reply.js, lib/route.js, fastify.js, lib/decorate.js, lib/plugin-override.js, lib/handle-request.js, test/types/plugin.test-d.ts, lib/promise.js

- **fastify:329e40f09f23** — MRR 1.000, Recall@10 1.000
  subject: fix: error throwing in reply (#6299)
  task: fix: error throwing in reply * fix: instantiate readable stream error * Create reply-web-stream-locked.test.js * fix test ---------
  gold: lib/reply.js
  top-ranked: lib/reply.js, test/types/plugin.test-d.ts, test/types/register.test-d.ts, test/internals/reply.test.js, fastify.js, lib/error-handler.js, test/diagnostics-channel/error-before-handler.test.js, test/diagnostics-channel/error-request.test.js, test/logger/logging.test.js, test/logger/instantiation.test.js

- **fastify:3f02c96bc379** — MRR 1.000, Recall@10 1.000
  subject: fix: return 431 status code on HTTP header overflow error (#4856)
  task: fix: return 431 status code on HTTP header overflow error
  gold: fastify.js
  top-ranked: fastify.js, lib/error-handler.js, lib/reply.js, lib/route.js, types/reply.d.ts, lib/validation.js, lib/request.js, test/internals/reply.test.js, test/types/route.test-d.ts, test/internals/request.test.js

- **axios:315ec44489ca** — MRR 1.000, Recall@10 1.000
  subject: refactor(http): extract Http2Sessions into its own module (#10861)
  task: refactor(http): extract Http2Sessions into its own module * refactor(http): extract Http2Sessions to lib/helpers for direct unit tests * fix(http2): clear pending idle timer when session closes * fix(http2): address review — strict mode, Node-only note, observable timer test ---------
  gold: lib/adapters/http.js
  top-ranked: lib/adapters/http.js, lib/defaults/index.js, lib/helpers/resolveConfig.js, index.d.ts, tests/unit/adapters/http.test.js, lib/core/AxiosHeaders.js, lib/adapters/fetch.js, index.d.cts, tests/setup/server.js, lib/core/InterceptorManager.js

- **axios:8d372335f5c5** — MRR 1.000, Recall@10 1.000
  subject: fix(http): fix 'socket hang up' bug for keep-alive requests when using timeouts; (#7206)
  task: fix(http): fix 'socket hang up' bug for keep-alive requests when using timeouts;
  gold: lib/adapters/http.js, test/unit/adapters/http.js
  top-ranked: lib/adapters/http.js, test/unit/adapters/http.js, test/helpers/server.js, test/unit/adapters/fetch.js, lib/adapters/xhr.js, index.js, lib/core/Axios.js, lib/adapters/fetch.js, lib/helpers/parseHeaders.js, test/specs/defaults.spec.js

## Environment / timing (non-deterministic section)

{"node":"v24.15.0","platform":"win32 10.0.26300","cpu":"AMD Ryzen 7 4800H with Radeon Graphics         ","totalMemGB":15.4}

timings (ms): {"snapshotMs":398026.2404000019,"indexMs":1642526.1231,"occMs":57298.265100001605,"baselinesMs":264844.1422}

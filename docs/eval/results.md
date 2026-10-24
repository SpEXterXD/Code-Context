# Retrieval Evaluation Results

Dataset hash `7d7187b6` · 500 tasks · seed 20260918 · split **eval** · eval-split run #1 this milestone · OCC commit `eb77bb1bccb2` · working tree clean at run start: yes

## Overall (mean [95% bootstrap CI], per task)

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.312 [0.270, 0.356] | 0.381 [0.348, 0.415] | 0.483 [0.451, 0.517] | 0.262 [0.226, 0.302] | 0.459 [0.422, 0.495] |
| filename | 0.182 [0.148, 0.216] | 0.258 [0.225, 0.290] | 0.346 [0.309, 0.379] | 0.222 [0.186, 0.260] | 0.287 [0.253, 0.319] |
| bm25 | 0.238 [0.200, 0.274] | 0.344 [0.309, 0.376] | 0.478 [0.442, 0.514] | 0.294 [0.252, 0.336] | 0.386 [0.351, 0.418] |
| random | 0.006 [0.000, 0.014] | 0.014 [0.007, 0.021] | 0.026 [0.015, 0.038] | 0.012 [0.004, 0.022] | 0.026 [0.018, 0.035] |

OCC generated package: mean 27129 tokens, mean 7.6 files included per task.

## Source-only gold slice (OCC-fully-parsed gold)

Full gold: 1382 gold files across 500 tasks. Source-only slice: 1335 gold files across 500 tasks (0 tasks excluded for an empty slice).

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.310 [0.270, 0.354] | 0.388 [0.355, 0.422] | 0.492 [0.460, 0.525] | 0.272 [0.232, 0.312] | 0.457 [0.421, 0.492] |
| filename | 0.172 [0.140, 0.206] | 0.258 [0.225, 0.290] | 0.347 [0.310, 0.381] | 0.226 [0.190, 0.262] | 0.277 [0.244, 0.308] |
| bm25 | 0.234 [0.198, 0.272] | 0.340 [0.304, 0.373] | 0.474 [0.437, 0.509] | 0.300 [0.258, 0.340] | 0.376 [0.343, 0.409] |
| random | 0.006 [0.000, 0.014] | 0.013 [0.006, 0.020] | 0.025 [0.014, 0.037] | 0.012 [0.004, 0.022] | 0.025 [0.017, 0.034] |

## Package recall (gold coverage of the delivered answer)

OCC = fraction of gold files inside the generated package (parsed from its `### FILE:` headings); baselines = Recall@8, matching OCC's mean package size.

| System | Package recall (mean [95% CI]) |
|---|---|
| occ | 0.332 [0.303, 0.365] |
| filename | 0.320 [0.288, 0.357] |
| bm25 | 0.437 [0.403, 0.473] |
| random | 0.019 [0.011, 0.029] |

## Paired bootstrap: OCC − BM25 per-task differences

### Full gold

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.074 [0.020, 0.128] | **yes** |
| recall5 | 0.038 [0.000, 0.077] | **yes** |
| recall10 | 0.006 [-0.030, 0.042] | no |
| allGoldAcc10 | -0.032 [-0.076, 0.006] | no |
| mrr | 0.074 [0.034, 0.114] | **yes** |
| packageRecall | -0.105 [-0.147, -0.060] | **yes** |

### Source-only slice

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.076 [0.024, 0.128] | **yes** |
| recall5 | 0.048 [0.009, 0.087] | **yes** |
| recall10 | 0.019 [-0.018, 0.060] | no |
| allGoldAcc10 | -0.028 [-0.068, 0.014] | no |
| mrr | 0.081 [0.038, 0.123] | **yes** |
| packageRecall | -0.099 [-0.142, -0.055] | **yes** |

## All-gold gap analysis (BM25 all-gold in top 10, OCC not)

61 tasks, 78 missing gold files. Missing by type: ci-config=1, docs=5, source=36, test=36. Not in OCC's candidate set at all: 30. Median OCC rank of missing files: 26; median BM25 rank: 4.

- **axios:38726c7586c6**
  - lib/utils.js (source): OCC rank 18, BM25 rank 10

- **axios:70302b6c9008**
  - lib/defaults/index.js (source): OCC rank 55, BM25 rank 8

- **axios:717f476b0f19**
  - README.md (docs): OCC rank 77, BM25 rank 2

- **fastify:16a74e7cb2d1**
  - test/content-parser.test.js (test): OCC rank 62, BM25 rank 9

- **fastify:3fd294dbe998**
  - lib/fourOhFour.js (source): OCC rank 37, BM25 rank 1
  - test/404s.test.js (test): OCC rank 31, BM25 rank 8

- **fastify:44589bedd478**
  - test/404s.test.js (test): OCC rank 41, BM25 rank 8

- **fastify:4467cfcd96db**
  - lib/pluginUtils.js (source): OCC rank not in candidates, BM25 rank 1

- **fastify:4bb798fccb15**
  - lib/route.js (source): OCC rank 13, BM25 rank 7
  - test/hooks.test.js (test): OCC rank 11, BM25 rank 8

- **fastify:562332a43ebd**
  - test/route.test.js (test): OCC rank 42, BM25 rank 6

- **fastify:628870555055**
  - test/404s.test.js (test): OCC rank 43, BM25 rank 8

- **fastify:897360ad9a01**
  - lib/contentTypeParser.js (source): OCC rank 26, BM25 rank 1

- **fastify:9bac49db2884**
  - test/listen.deprecated.test.js (test): OCC rank 31, BM25 rank 5

- **fastify:ad2da127e78b**
  - docs/Reference/Plugins.md (docs): OCC rank 35, BM25 rank 7

- **fastify:edbb82035c6e**
  - test/reply-trailers.test.js (test): OCC rank not in candidates, BM25 rank 1

- **hono:00f32b7c17e4**
  - src/client/client.test.ts (test): OCC rank 17, BM25 rank 6

- **hono:034223f1bf8d**
  - src/middleware/trailing-slash/index.test.ts (test): OCC rank not in candidates, BM25 rank 3
  - src/middleware/trailing-slash/index.ts (source): OCC rank not in candidates, BM25 rank 4

- **hono:20d877167c8b**
  - src/jsx/intrinsic-elements.ts (source): OCC rank 37, BM25 rank 5

- **hono:274191cf9282**
  - src/middleware/jwt/index.test.ts (test): OCC rank not in candidates, BM25 rank 6

- **hono:44f884321a1d**
  - src/helper/streaming/sse.test.tsx (test): OCC rank 18, BM25 rank 1

- **hono:4d9f2a2ed4bf**
  - adapters/bun/package.json (ci-config): OCC rank not in candidates, BM25 rank 10
  - adapters/bun/vite.config.ts (source): OCC rank not in candidates, BM25 rank 5
  - docs/MAINTAINING.md (docs): OCC rank not in candidates, BM25 rank 2

- **hono:52febbcc30bc**
  - src/utils/jwt/jwt.test.ts (test): OCC rank not in candidates, BM25 rank 1

- **hono:5a25e33e93aa**
  - src/middleware/secure-headers/index.test.ts (test): OCC rank 17, BM25 rank 2

- **hono:76d5589e9b05**
  - src/middleware/cors/index.test.ts (test): OCC rank 69, BM25 rank 2

- **hono:879557f35fb7**
  - src/jsx/index.test.tsx (test): OCC rank 20, BM25 rank 5

- **hono:9cdfdf3c65af**
  - src/context.test.ts (test): OCC rank 13, BM25 rank 8

- **hono:a285c4b3b4bc**
  - src/helper/adapter/index.ts (source): OCC rank 17, BM25 rank 1

- **hono:adecab1caeb2**
  - benchmarks/routers/README.md (docs): OCC rank not in candidates, BM25 rank 1

- **hono:b0eb512b2182**
  - src/helper.ts (source): OCC rank not in candidates, BM25 rank 3

- **hono:b6934cb210f5**
  - vitest.config.ts (source): OCC rank not in candidates, BM25 rank 1

- **hono:cb2416042cea**
  - deno_dist/request.ts (source): OCC rank 42, BM25 rank 2
  - src/hono.test.ts (test): OCC rank 22, BM25 rank 8
  - src/request.ts (source): OCC rank 46, BM25 rank 1

- **hono:d5e7da31132f**
  - src/request.ts (source): OCC rank 22, BM25 rank 3

- **hono:d9b8b4b73b4f**
  - src/middleware/cors/index.test.ts (test): OCC rank 33, BM25 rank 3

- **hono:e0cdeb0a89e7**
  - src/middleware/method-override/index.test.ts (test): OCC rank 26, BM25 rank 8

- **hono:edbf6eea8e6c**
  - src/utils/ipaddr.test.ts (test): OCC rank 31, BM25 rank 9

- **hono:ff715fca4bd5**
  - src/router/reg-exp-router/prepared-router.test.ts (test): OCC rank 19, BM25 rank 2

- **undici:0160a719063f**
  - lib/handler/retry-handler.js (source): OCC rank 13, BM25 rank 2
  - test/interceptors/retry.js (test): OCC rank not in candidates, BM25 rank 5

- **undici:0712f7d6f3bc**
  - test/env-http-proxy-agent.js (test): OCC rank 40, BM25 rank 3

- **undici:07276c90545b**
  - lib/core/symbols.js (source): OCC rank 14, BM25 rank 10

- **undici:3e622dc7947b**
  - test/cache-interceptor/memory-cache-store-tests.js (test): OCC rank 56, BM25 rank 4

- **undici:5453139e5e41**
  - lib/mock/snapshot-agent.js (source): OCC rank 17, BM25 rank 5
  - lib/mock/snapshot-recorder.js (source): OCC rank 13, BM25 rank 1
  - test/snapshot-recorder.js (test): OCC rank 16, BM25 rank 2
  - test/snapshot-testing.js (test): OCC rank 22, BM25 rank 6

- **undici:69825dc1483d**
  - CONTRIBUTING.md (docs): OCC rank 55, BM25 rank 1
  - build/wasm.js (source): OCC rank not in candidates, BM25 rank 4

- **undici:7da8232df9fb**
  - lib/api/util.js (source): OCC rank 12, BM25 rank 3

- **undici:8a5de7cdad14**
  - lib/cache/sqlite-cache-store.js (source): OCC rank 20, BM25 rank 4

- **undici:93025998e99a**
  - lib/web/websocket/receiver.js (source): OCC rank not in candidates, BM25 rank 1
  - lib/web/websocket/util.js (source): OCC rank not in candidates, BM25 rank 9

- **undici:95bd9290c4e5**
  - lib/core/symbols.js (source): OCC rank 26, BM25 rank 1

- **undici:a217002369c4**
  - index-fetch.js (source): OCC rank not in candidates, BM25 rank 4

- **undici:a4eaed1124ec**
  - lib/web/fetch/index.js (source): OCC rank not in candidates, BM25 rank 3

- **undici:ae18f0e7dade**
  - lib/web/websocket/receiver.js (source): OCC rank not in candidates, BM25 rank 3

- **undici:b5084c7dc239**
  - test/fetch/encoding.js (test): OCC rank 59, BM25 rank 1

- **undici:b54d24b44db7**
  - lib/core/request.js (source): OCC rank 15, BM25 rank 9
  - test/node-test/util.js (test): OCC rank not in candidates, BM25 rank 1

- **undici:be564c1573f4**
  - lib/web/fetch/index.js (source): OCC rank not in candidates, BM25 rank 2
  - test/fetch/401-statuscode-no-infinite-loop.js (test): OCC rank not in candidates, BM25 rank 4

- **undici:d0399c40f116**
  - test/interceptors/dump-interceptor.js (test): OCC rank 72, BM25 rank 3

- **undici:deccde64ac51**
  - scripts/generate-undici-types-package-json.js (source): OCC rank 11, BM25 rank 1

- **undici:ef276d4a296b**
  - test/interceptors/retry.js (test): OCC rank not in candidates, BM25 rank 6
  - test/retry-handler.js (test): OCC rank not in candidates, BM25 rank 2

- **zod:599c0e41dccb**
  - packages/docs/components/ecosystem.tsx (source): OCC rank not in candidates, BM25 rank 2

- **zod:6407bed5a229**
  - deno/lib/__tests__/discriminated-unions.test.ts (test): OCC rank not in candidates, BM25 rank 8
  - src/__tests__/discriminated-unions.test.ts (test): OCC rank not in candidates, BM25 rank 7

- **zod:81d9fc6cf47d**
  - packages/docs/components/ecosystem.tsx (source): OCC rank not in candidates, BM25 rank 6

- **zod:cede2c63739a**
  - packages/zod/src/v4/classic/tests/tuple.test.ts (test): OCC rank not in candidates, BM25 rank 1

- **zod:d3da530deb71**
  - packages/zod/src/v4/core/schemas.ts (source): OCC rank 56, BM25 rank 5

- **zod:e06af5de314f**
  - packages/docs/components/ecosystem.tsx (source): OCC rank not in candidates, BM25 rank 6

- **zod:f8fef45cfa81**
  - packages/docs/components/ecosystem.tsx (source): OCC rank 15, BM25 rank 9

## Per repository

### axios (pinned e6b79d9cef79, MIT)
Mined 2036, accepted 540, sampled 100, evaluated 100 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 11, non-localizable gold files excluded from accepted tasks: 83. Top rejections: bot-author=474, ci-only=117, docs-only=321, file-count=125, format-only=5.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.360 [0.260, 0.450] | 0.501 [0.424, 0.577] | 0.607 [0.534, 0.680] | 0.380 [0.290, 0.480] | 0.534 [0.459, 0.602] |
| filename | 0.210 [0.130, 0.290] | 0.279 [0.200, 0.357] | 0.365 [0.281, 0.441] | 0.260 [0.180, 0.340] | 0.302 [0.222, 0.376] |
| bm25 | 0.180 [0.110, 0.260] | 0.275 [0.210, 0.344] | 0.422 [0.353, 0.497] | 0.240 [0.170, 0.320] | 0.339 [0.274, 0.410] |
| random | 0.020 [0.000, 0.050] | 0.011 [0.002, 0.024] | 0.031 [0.005, 0.065] | 0.020 [0.000, 0.050] | 0.040 [0.016, 0.071] |

### fastify (pinned ce41dc0fbb4e, MIT)
Mined 4474, accepted 684, sampled 100, evaluated 100 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 1, non-localizable gold files excluded from accepted tasks: 114. Top rejections: bot-author=988, ci-only=237, docs-only=1010, file-count=133, format-only=21.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.340 [0.250, 0.430] | 0.328 [0.276, 0.383] | 0.384 [0.326, 0.446] | 0.100 [0.040, 0.160] | 0.497 [0.422, 0.570] |
| filename | 0.100 [0.050, 0.160] | 0.180 [0.132, 0.231] | 0.281 [0.221, 0.337] | 0.080 [0.030, 0.130] | 0.230 [0.175, 0.288] |
| bm25 | 0.210 [0.130, 0.290] | 0.279 [0.222, 0.350] | 0.435 [0.367, 0.501] | 0.190 [0.120, 0.270] | 0.375 [0.305, 0.445] |
| random | 0.000 [0.000, 0.000] | 0.018 [0.005, 0.037] | 0.025 [0.008, 0.045] | 0.000 [0.000, 0.000] | 0.024 [0.013, 0.037] |

### hono (pinned 5ca49b072075, MIT)
Mined 2803, accepted 1181, sampled 100, evaluated 100 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 4, non-localizable gold files excluded from accepted tasks: 158. Top rejections: bot-author=458, ci-only=101, docs-only=106, file-count=191, format-only=7.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.330 [0.240, 0.420] | 0.484 [0.403, 0.563] | 0.664 [0.587, 0.735] | 0.480 [0.380, 0.580] | 0.489 [0.410, 0.562] |
| filename | 0.260 [0.170, 0.340] | 0.415 [0.334, 0.495] | 0.600 [0.524, 0.688] | 0.490 [0.400, 0.590] | 0.394 [0.319, 0.466] |
| bm25 | 0.450 [0.350, 0.550] | 0.580 [0.502, 0.655] | 0.715 [0.642, 0.785] | 0.570 [0.470, 0.660] | 0.586 [0.510, 0.664] |
| random | 0.000 [0.000, 0.000] | 0.016 [0.000, 0.040] | 0.030 [0.003, 0.062] | 0.020 [0.000, 0.050] | 0.019 [0.007, 0.032] |

### undici (pinned 1f452240899a, MIT)
Mined 4353, accepted 1449, sampled 100, evaluated 100 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 2, non-localizable gold files excluded from accepted tasks: 305. Top rejections: bot-author=1101, ci-only=102, docs-only=210, file-count=166, format-only=6.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.230 [0.150, 0.310] | 0.268 [0.197, 0.333] | 0.368 [0.291, 0.441] | 0.220 [0.140, 0.300] | 0.352 [0.274, 0.426] |
| filename | 0.180 [0.110, 0.260] | 0.217 [0.143, 0.293] | 0.241 [0.165, 0.319] | 0.150 [0.080, 0.220] | 0.250 [0.178, 0.323] |
| bm25 | 0.270 [0.180, 0.360] | 0.404 [0.324, 0.484] | 0.480 [0.400, 0.561] | 0.330 [0.240, 0.430] | 0.406 [0.326, 0.483] |
| random | 0.000 [0.000, 0.000] | 0.013 [0.000, 0.035] | 0.016 [0.000, 0.041] | 0.010 [0.000, 0.030] | 0.015 [0.004, 0.032] |

### zod (pinned afdac65e0f80, MIT)
Mined 2935, accepted 494, sampled 100, evaluated 100 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 8, non-localizable gold files excluded from accepted tasks: 70. Top rejections: bot-author=565, ci-only=128, docs-only=488, file-count=183, format-only=44.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.300 [0.210, 0.400] | 0.325 [0.267, 0.392] | 0.394 [0.335, 0.458] | 0.130 [0.070, 0.200] | 0.425 [0.350, 0.507] |
| filename | 0.160 [0.090, 0.240] | 0.199 [0.136, 0.269] | 0.243 [0.180, 0.315] | 0.130 [0.070, 0.200] | 0.259 [0.191, 0.332] |
| bm25 | 0.080 [0.030, 0.140] | 0.181 [0.126, 0.239] | 0.338 [0.273, 0.405] | 0.140 [0.080, 0.220] | 0.223 [0.175, 0.274] |
| random | 0.010 [0.000, 0.030] | 0.011 [0.001, 0.026] | 0.028 [0.007, 0.054] | 0.010 [0.000, 0.030] | 0.032 [0.014, 0.059] |

## Case studies (OCC)

### Worst 5 failures (lowest MRR)

- **hono:645b4f21eb2c** — MRR 0.000, Recall@10 0.000
  subject: fix(jsx/dom): Fixed to not give "px" for certain properties, even if numeric value is given (#2845)
  task: fix(jsx/dom): Fixed to not give "px" for certain properties, even if numeric value is given
  gold: src/jsx/utils.ts
  top-ranked: src/jsx/intrinsic-elements.ts, src/jsx/dom/index.test.tsx, src/adapter/aws-lambda/handler.ts, src/jsx/base.ts, src/jsx/dom/render.ts, src/jsx/jsx-runtime.ts, src/jsx/constants.ts, src/jsx/dom/index.ts, src/jsx/dom/utils.ts, src/adapter/aws-lambda/custom-context.ts

- **hono:b6934cb210f5** — MRR 0.000, Recall@10 0.000
  subject: chore: Exclude type-only files from coverage (#2890)
  task: chore: Exclude type-only files from coverage
  gold: vitest.config.ts
  top-ranked: src/helper/ssg/ssg.ts, src/helper/ssg/ssg.test.tsx, src/validator/validator.ts, src/types.ts, src/helper/ssg/middleware.ts, src/adapter/deno/ssg.ts, src/adapter/bun/ssg.ts, src/validator/validator.test.ts, src/index.ts, src/types.test.ts

- **hono:9a6e52d734df** — MRR 0.000, Recall@10 0.000
  subject: feat(middleware/combine): Introduce combine middleware (#2941)
  task: feat(middleware/combine): Introduce combine middleware * feat(middleware/predicate): Introduce predicate middleware * fix: apply `bun run format:fix` * refactor: rename middleware predicate -> combine
  gold: jsr.json, package.json
  top-ranked: src/types.test.ts, src/utils/concurrent.ts, src/jsx/dom/render.ts, src/helper/ssg/ssg.ts, src/adapter/bun/websocket.ts, src/helper/streaming/sse.ts, src/helper/ssg/middleware.ts, src/adapter/bun/server.ts, src/compose.test.ts, runtime_tests/deno/middleware.test.tsx

- **hono:034223f1bf8d** — MRR 0.000, Recall@10 0.000
  subject: feat(trailing-slash): add `alwaysRedirect` option to support wildcard routes (#4658)
  task: feat(trailing-slash): add `alwaysRedirect` option to support wildcard routes * feat(trailing-slash): add `strict` option to support wildcard routes * use `eager` instead of `strict` * replace `eager` to `alwaysRedirect`
  gold: src/middleware/trailing-slash/index.test.ts, src/middleware/trailing-slash/index.ts
  top-ranked: src/helper/css/common.case.test.tsx, benchmarks/routers/src/tool.mts, benchmarks/routers-deno/src/tool.mts, src/jsx/intrinsic-elements.ts, src/helper/ssg/ssg.ts, src/client/utils.test.ts, src/router/reg-exp-router/router.ts, src/hono-base.ts, src/helper/ssg/plugins.ts, src/types.test.ts

- **hono:4d9f2a2ed4bf** — MRR 0.000, Recall@10 0.000
  subject: chore(adapters/bun): ship ESM only (#5462)
  task: chore(adapters/bun): ship ESM only
  gold: adapters/bun/package.json, adapters/bun/vite.config.ts, docs/MAINTAINING.md
  top-ranked: adapters/bun/src/websocket.ts, src/adapter/bun/websocket.ts, adapters/bun/src/index.ts, src/adapter/bun/index.ts, adapters/bun/src/server.ts, adapters/bun/src/websocket.test.ts, src/adapter/bun/server.ts, runtime-tests/bun/index.test.tsx, adapters/bun/src/conninfo.test.ts, adapters/bun/src/conninfo.ts

### Best 5 successes (highest MRR)

- **fastify:329e40f09f23** — MRR 1.000, Recall@10 1.000
  subject: fix: error throwing in reply (#6299)
  task: fix: error throwing in reply * fix: instantiate readable stream error * Create reply-web-stream-locked.test.js * fix test ---------
  gold: lib/reply.js
  top-ranked: lib/reply.js, test/types/plugin.test-d.ts, test/types/register.test-d.ts, test/internals/reply.test.js, fastify.js, lib/error-handler.js, test/diagnostics-channel/error-before-handler.test.js, test/diagnostics-channel/error-request.test.js, test/logger/logging.test.js, test/logger/instantiation.test.js

- **fastify:9be9fc07b769** — MRR 1.000, Recall@10 1.000
  subject: fix: remove unnecessary body length check in contentTypeParser (#6266)
  task: fix: remove unnecessary body length check in contentTypeParser
  gold: lib/contentTypeParser.js
  top-ranked: lib/contentTypeParser.js, lib/configValidator.js, docs/Reference/ContentTypeParser.md, fastify.js, types/content-type-parser.d.ts, lib/pluginUtils.js, lib/decorate.js, lib/reply.js, lib/initialConfigValidation.js, test/types/instance.test-d.ts

- **fastify:e61c39474525** — MRR 1.000, Recall@10 1.000
  subject: chore: getFuncPreview limit split size (#5754)
  task: chore: getFuncPreview limit split size
  gold: lib/pluginUtils.js
  top-ranked: lib/pluginUtils.js, lib/request.js, fastify.js, lib/route.js, lib/contentTypeParser.js, lib/schema-controller.js, test/listen.4.test.js, test/internals/reply.test.js, lib/logger.js, test/logger/instantiation.test.js

- **fastify:c65a6be1b5ec** — MRR 1.000, Recall@10 1.000
  subject: fix extend isCustomValidatorCompiler from parent controller (#4903)
  task: fix extend isCustomValidatorCompiler from parent controller
  gold: lib/schema-controller.js, test/internals/request-validate.test.js
  top-ranked: test/internals/request-validate.test.js, lib/schema-controller.js, lib/route.js, fastify.js, test/internals/reply.test.js, lib/validation.js, lib/reply.js, lib/request.js, test/internals/handleRequest.test.js, lib/contentTypeParser.js

- **fastify:c79b49e2aa2c** — MRR 1.000, Recall@10 1.000
  subject: [hooks] Refine hook runners (#4805)
  task: [hooks] Refine hook runners * remove hook iterator for onRequestAbortHookRunner * curry it * rename stream to payload * early exit with cb instead of next * rename payload to newPayload * change
  gold: lib/handleRequest.js, lib/hooks.js, lib/reply.js, lib/route.js, test/internals/hookRunner.test.js
  top-ranked: test/internals/hookRunner.test.js, lib/hooks.js, lib/reply.js, lib/route.js, fastify.js, lib/contentTypeParser.js, test/internals/reply.test.js, lib/fourOhFour.js, lib/handleRequest.js, test/internals/handleRequest.test.js

## Environment / timing (non-deterministic section)

{"node":"v24.15.0","platform":"win32 10.0.26300","cpu":"AMD Ryzen 7 4800H with Radeon Graphics         ","totalMemGB":15.4}

timings (ms): {"snapshotMs":403026.8283000007,"indexMs":2045603.1834000007,"occMs":68280.3318999962,"baselinesMs":369235.10639999656}

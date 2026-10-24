# Retrieval Evaluation Results — HOLDOUT (single shot)

Dataset hash `7da65d58` · 300 tasks · seed 20260918 · split **holdout** · OCC commit `c0df0ba79d24` · working tree clean at run start: yes

## Overall (mean [95% bootstrap CI], per task)

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.303 [0.250, 0.353] | 0.438 [0.398, 0.476] | 0.560 [0.518, 0.598] | 0.327 [0.270, 0.377] | 0.483 [0.439, 0.524] |
| filename | 0.203 [0.160, 0.250] | 0.279 [0.237, 0.320] | 0.379 [0.334, 0.426] | 0.257 [0.210, 0.307] | 0.307 [0.264, 0.347] |
| bm25 | 0.200 [0.157, 0.243] | 0.305 [0.263, 0.344] | 0.466 [0.419, 0.511] | 0.273 [0.220, 0.323] | 0.345 [0.308, 0.383] |
| random | 0.000 [0.000, 0.000] | 0.005 [0.000, 0.010] | 0.015 [0.005, 0.028] | 0.007 [0.000, 0.017] | 0.017 [0.012, 0.023] |

OCC generated package: mean 27403 tokens, mean 7.9 files included per task.

## Source-only gold slice (OCC-fully-parsed gold)

Full gold: 817 gold files across 300 tasks. Source-only slice: 790 gold files across 300 tasks (0 tasks excluded for an empty slice).

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.300 [0.247, 0.350] | 0.442 [0.401, 0.481] | 0.564 [0.520, 0.602] | 0.330 [0.273, 0.380] | 0.479 [0.435, 0.521] |
| filename | 0.197 [0.153, 0.240] | 0.278 [0.236, 0.321] | 0.377 [0.332, 0.424] | 0.257 [0.210, 0.307] | 0.301 [0.259, 0.340] |
| bm25 | 0.187 [0.143, 0.230] | 0.302 [0.261, 0.340] | 0.462 [0.413, 0.507] | 0.277 [0.223, 0.327] | 0.328 [0.292, 0.367] |
| random | 0.000 [0.000, 0.000] | 0.005 [0.000, 0.010] | 0.015 [0.005, 0.028] | 0.007 [0.000, 0.017] | 0.017 [0.012, 0.023] |

## Package recall (gold coverage of the delivered answer)

OCC = fraction of gold files inside the generated package (parsed from its `### FILE:` headings); baselines = Recall@8, matching OCC's mean package size.

| System | Package recall (mean [95% CI]) |
|---|---|
| occ | 0.458 [0.414, 0.501] |
| filename | 0.335 [0.294, 0.379] |
| bm25 | 0.412 [0.367, 0.458] |
| random | 0.015 [0.006, 0.027] |

## Paired bootstrap: OCC − BM25 per-task differences

### Full gold

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.103 [0.040, 0.170] | **yes** |
| recall5 | 0.133 [0.083, 0.184] | **yes** |
| recall10 | 0.094 [0.044, 0.143] | **yes** |
| allGoldAcc10 | 0.053 [0.003, 0.110] | **yes** |
| mrr | 0.138 [0.086, 0.189] | **yes** |
| packageRecall | 0.046 [-0.004, 0.100] | no |

### Source-only slice

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.113 [0.047, 0.177] | **yes** |
| recall5 | 0.139 [0.088, 0.188] | **yes** |
| recall10 | 0.102 [0.058, 0.147] | **yes** |
| allGoldAcc10 | 0.053 [0.003, 0.103] | **yes** |
| mrr | 0.151 [0.099, 0.200] | **yes** |
| packageRecall | 0.053 [-0.003, 0.103] | no |

## Paired bootstrap: OCC(M3b) − OCC(M3, P1 ablated in-process)

### Full gold

| Metric | Mean diff (M3b − M3) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.000 [0.000, 0.000] | no |
| recall5 | 0.000 [0.000, 0.000] | no |
| recall10 | 0.000 [0.000, 0.000] | no |
| allGoldAcc10 | 0.000 [0.000, 0.000] | no |
| mrr | 0.000 [0.000, 0.000] | no |
| packageRecall | 0.086 [0.058, 0.113] | **yes** |

### Source-only slice

| Metric | Mean diff (M3b − M3) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.000 [0.000, 0.000] | no |
| recall5 | 0.000 [0.000, 0.000] | no |
| recall10 | 0.000 [0.000, 0.000] | no |
| allGoldAcc10 | 0.000 [0.000, 0.000] | no |
| mrr | 0.000 [0.000, 0.000] | no |
| packageRecall | 0.087 [0.057, 0.114] | **yes** |

## All-gold gap analysis (BM25 all-gold in top 10, OCC not)

24 tasks, 27 missing gold files. Missing by type: docs=4, source=11, test=12. Not in OCC's candidate set at all: 7. Median OCC rank of missing files: 23; median BM25 rank: 5.

- **axios:3772c8fe7411**
  - lib/platform/browser/index.js (source): OCC rank not in candidates, BM25 rank 8

- **axios:640458daaf09**
  - tests/browser/cancel.browser.test.js (test): OCC rank 16, BM25 rank 5

- **axios:c19f7bf770f9**
  - lib/adapters/http.js (source): OCC rank 11, BM25 rank 10

- **fastify:183576d342e8**
  - test/reply-trailers.test.js (test): OCC rank 23, BM25 rank 4

- **fastify:4723c1b228f4**
  - test/content-parser.test.js (test): OCC rank 21, BM25 rank 6

- **fastify:50d1e586a0c3**
  - test/listen.test.js (test): OCC rank 20, BM25 rank 7

- **fastify:80414553e045**
  - docs/Validation-and-Serialization.md (docs): OCC rank 50, BM25 rank 10
  - test/validation-error-handling.test.js (test): OCC rank 46, BM25 rank 8

- **fastify:b52b4c276def**
  - fastify.js (source): OCC rank 11, BM25 rank 9

- **fastify:c89945df8b6e**
  - test/web-api.test.js (test): OCC rank 55, BM25 rank 8

- **hono:0d86899d28e1**
  - src/adapter/aws-lambda/handler.test.ts (test): OCC rank 15, BM25 rank 2

- **hono:2d532abaed26**
  - src/test-utils/setup-vitest.ts (source): OCC rank not in candidates, BM25 rank 1

- **hono:45ba3bf9e3df**
  - src/utils/jwt/jwt.test.ts (test): OCC rank 13, BM25 rank 5

- **hono:c78932d745cd**
  - src/utils/ipaddr.test.ts (test): OCC rank not in candidates, BM25 rank 4

- **hono:fc8fb0f730d9**
  - src/middleware/cors/index.test.ts (test): OCC rank 34, BM25 rank 2

- **undici:14757d5ed207**
  - README.md (docs): OCC rank 80, BM25 rank 2

- **undici:65e097fea6ad**
  - test/fetch/util.js (test): OCC rank 54, BM25 rank 5

- **undici:86936d968791**
  - CONTRIBUTING.md (docs): OCC rank not in candidates, BM25 rank 3
  - build/wasm.js (source): OCC rank not in candidates, BM25 rank 1

- **undici:e041de359221**
  - lib/fetch/index.js (source): OCC rank 39, BM25 rank 6

- **undici:f182ff12d522**
  - lib/dispatcher/client-h1.js (source): OCC rank 26, BM25 rank 3

- **zod:6887ff34fb9b**
  - packages/docs/components/ecosystem.tsx (source): OCC rank 19, BM25 rank 3

- **zod:74458e9ccec6**
  - packages/docs/components/ecosystem-v3.tsx (source): OCC rank 57, BM25 rank 1
  - packages/docs/components/ecosystem.tsx (source): OCC rank 56, BM25 rank 2

- **zod:8b723d417326**
  - deno/lib/README.md (docs): OCC rank not in candidates, BM25 rank 2

- **zod:b748b914d9a0**
  - packages/docs/components/ecosystem.tsx (source): OCC rank 11, BM25 rank 10

- **zod:fa338a3b885e**
  - packages/zod/src/v4/classic/tests/to-json-schema.test.ts (test): OCC rank not in candidates, BM25 rank 7

## Per repository

### axios (pinned e6b79d9cef79, MIT)
Mined 2036, accepted 540, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 11, non-localizable gold files excluded from accepted tasks: 83. Top rejections: bot-author=474, ci-only=117, docs-only=321, file-count=125, format-only=5.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.350 [0.233, 0.483] | 0.552 [0.452, 0.651] | 0.680 [0.587, 0.766] | 0.450 [0.317, 0.583] | 0.544 [0.454, 0.636] |
| filename | 0.200 [0.100, 0.300] | 0.307 [0.198, 0.422] | 0.426 [0.320, 0.539] | 0.317 [0.200, 0.433] | 0.314 [0.218, 0.410] |
| bm25 | 0.117 [0.033, 0.200] | 0.224 [0.140, 0.314] | 0.436 [0.331, 0.544] | 0.300 [0.200, 0.417] | 0.253 [0.181, 0.327] |
| random | 0.000 [0.000, 0.000] | 0.008 [0.000, 0.025] | 0.050 [0.008, 0.106] | 0.033 [0.000, 0.083] | 0.026 [0.015, 0.041] |

### fastify (pinned ce41dc0fbb4e, MIT)
Mined 4474, accepted 684, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 1, non-localizable gold files excluded from accepted tasks: 114. Top rejections: bot-author=988, ci-only=237, docs-only=1010, file-count=133, format-only=21.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.233 [0.133, 0.350] | 0.352 [0.278, 0.429] | 0.463 [0.382, 0.544] | 0.167 [0.083, 0.267] | 0.450 [0.363, 0.540] |
| filename | 0.150 [0.067, 0.250] | 0.212 [0.142, 0.285] | 0.340 [0.256, 0.433] | 0.183 [0.100, 0.283] | 0.278 [0.194, 0.369] |
| bm25 | 0.167 [0.083, 0.267] | 0.246 [0.186, 0.318] | 0.446 [0.354, 0.537] | 0.167 [0.083, 0.267] | 0.338 [0.258, 0.429] |
| random | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.011 [0.000, 0.028] | 0.000 [0.000, 0.000] | 0.017 [0.010, 0.026] |

### hono (pinned 5ca49b072075, MIT)
Mined 2803, accepted 1181, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 4, non-localizable gold files excluded from accepted tasks: 158. Top rejections: bot-author=458, ci-only=101, docs-only=106, file-count=191, format-only=7.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.283 [0.167, 0.400] | 0.532 [0.438, 0.614] | 0.659 [0.571, 0.742] | 0.417 [0.283, 0.533] | 0.491 [0.406, 0.590] |
| filename | 0.367 [0.250, 0.483] | 0.498 [0.383, 0.608] | 0.663 [0.551, 0.761] | 0.500 [0.383, 0.633] | 0.501 [0.398, 0.602] |
| bm25 | 0.483 [0.350, 0.617] | 0.518 [0.417, 0.619] | 0.633 [0.540, 0.719] | 0.417 [0.300, 0.533] | 0.588 [0.482, 0.698] |
| random | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.013 [0.007, 0.019] |

### undici (pinned 1f452240899a, MIT)
Mined 4353, accepted 1449, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 2, non-localizable gold files excluded from accepted tasks: 305. Top rejections: bot-author=1101, ci-only=102, docs-only=210, file-count=166, format-only=6.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.250 [0.133, 0.367] | 0.348 [0.254, 0.438] | 0.446 [0.349, 0.543] | 0.283 [0.167, 0.400] | 0.399 [0.297, 0.491] |
| filename | 0.100 [0.033, 0.183] | 0.143 [0.071, 0.229] | 0.188 [0.108, 0.282] | 0.117 [0.033, 0.200] | 0.156 [0.088, 0.241] |
| bm25 | 0.183 [0.100, 0.283] | 0.326 [0.226, 0.429] | 0.433 [0.328, 0.535] | 0.267 [0.150, 0.367] | 0.326 [0.241, 0.411] |
| random | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.003 [0.000, 0.007] |

### zod (pinned afdac65e0f80, MIT)
Mined 2935, accepted 494, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 8, non-localizable gold files excluded from accepted tasks: 70. Top rejections: bot-author=565, ci-only=128, docs-only=488, file-count=183, format-only=44.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.400 [0.283, 0.517] | 0.404 [0.313, 0.500] | 0.553 [0.459, 0.643] | 0.317 [0.200, 0.433] | 0.532 [0.438, 0.633] |
| filename | 0.200 [0.100, 0.300] | 0.234 [0.149, 0.325] | 0.279 [0.192, 0.375] | 0.167 [0.083, 0.267] | 0.288 [0.194, 0.387] |
| bm25 | 0.050 [0.000, 0.117] | 0.209 [0.134, 0.290] | 0.384 [0.282, 0.489] | 0.217 [0.117, 0.333] | 0.219 [0.163, 0.279] |
| random | 0.000 [0.000, 0.000] | 0.015 [0.000, 0.035] | 0.015 [0.000, 0.035] | 0.000 [0.000, 0.000] | 0.026 [0.008, 0.049] |

## Case studies (OCC)

### Worst 5 failures (lowest MRR)

- **hono:2d532abaed26** — MRR 0.000, Recall@10 0.000
  subject: test: stub `crypto` if not exist (#2445)
  task: test: stub `crypto` if not exist
  gold: src/test-utils/setup-vitest.ts
  top-ranked: deno_dist/jsx/intrinsic-elements.ts, src/jsx/intrinsic-elements.ts, runtime_tests/lambda/index.test.ts, deno_dist/utils/crypto.ts, src/utils/crypto.ts, src/utils/jwt/jws.ts, src/utils/crypto.test.ts, src/utils/buffer.test.ts, src/middleware/cache/index.ts, src/helper/testing/index.ts

- **hono:fc9cc6da28de** — MRR 0.000, Recall@10 0.000
  subject: feat(powered-by): optional server name (#3492)
  task: feat(powered-by): optional server name * refactor(powered-by): optional server name * style(powered-by): format * test(powered-by): test new config * Update index.test.ts
  gold: src/middleware/powered-by/index.test.ts, src/middleware/powered-by/index.ts
  top-ranked: src/helper/css/index.ts, src/jsx/dom/render.ts, src/jsx/dom/css.ts, src/jsx/intrinsic-element/components.ts, src/jsx/dom/intrinsic-element/components.ts, src/jsx/intrinsic-elements.ts, src/jsx/dom/server.ts, src/helper/css/common.ts, src/types.test.ts, src/jsx/hooks/index.ts

- **hono:7735f2f03c90** — MRR 0.000, Recall@10 0.000
  subject: fix(vercel): remove `requestContext` (#3549)
  task: fix(vercel): remove `requestContext`
  gold: src/adapter/vercel/handler.test.ts, src/adapter/vercel/handler.ts
  top-ranked: src/context.ts, src/middleware/jsx-renderer/index.ts, src/jsx/dom/render.ts, src/client/client.test.ts, src/middleware/request-id/request-id.ts, src/adapter/aws-lambda/handler.ts, src/jsx/context.ts, src/middleware/secure-headers/index.test.ts, src/types.test.ts, src/middleware/request-id/index.ts

- **hono:31d6e6c20994** — MRR 0.000, Recall@10 0.000
  subject: feat(helper/proxy): introduce proxy helper (#3589)
  task: feat(helper/proxy): introduce proxy helper * feat(helper/proxy): introduce proxy helper * chore(helper/proxy): expose proxy helper * test(helper/proxy): fix test name * fix(helper/proxy): return Content-Range header as it is * refactor(helper/proxy): return the original content-length if the respons…
  gold: jsr.json, package.json
  top-ranked: src/request.ts, src/types.test.ts, src/jsx/dom/render.ts, src/middleware/secure-headers/secure-headers.ts, src/client/types.ts, src/jsx/intrinsic-elements.ts, src/context.ts, src/adapter/lambda-edge/handler.ts, src/helper/accepts/accepts.ts, src/jsx/dom/index.test.tsx

- **hono:46ec30012654** — MRR 0.000, Recall@10 0.000
  subject: chore: improve private field removal (#4513)
  task: chore: improve private field removal * chore: improve private field removal * test: add test for removePrivateFields * chore: format code
  gold: build/build.ts, build/remove-private-fields-worker.test.ts, build/remove-private-fields-worker.ts, build/remove-private-fields.ts, bun.lock, package.json
  top-ranked: src/jsx/intrinsic-elements.ts, src/middleware/jwk/keys.test.json, benchmarks/http-server/benchmark.ts, runtime-tests/lambda/index.test.ts, src/types.test.ts, src/validator/validator.test.ts, src/types.ts, src/utils/jwt/jwt.test.ts, src/client/utils.ts, src/jsx/dom/render.ts

### Best 5 successes (highest MRR)

- **fastify:0d945819bebc** — MRR 1.000, Recall@10 1.000
  subject: perf: use a FIFO cache for parsed content-types (#7071)
  task: perf: use a FIFO cache for parsed content-types As we do for the [content-type parsers]( I propose using a FifoMap here The content-type cache holds far fewer distinct values than its 100 slots in the common case, so eviction order rarely matters and bumping entries on every hit is a performance pen…
  gold: lib/content-type.js
  top-ranked: lib/content-type.js, test/internals/plugin.test.js, lib/reply.js, docs/Reference/TypeScript.md, lib/request.js, lib/route.js, test/internals/reply.test.js, fastify.js, lib/content-type-parser.js, lib/handle-request.js

- **fastify:39f35f9a0596** — MRR 1.000, Recall@10 1.000
  subject: fix: fix typo of deprecation warning FSTDEP022 (#6313)
  task: fix: fix typo of deprecation warning FSTDEP022
  gold: lib/warnings.js
  top-ranked: lib/warnings.js, docs/Reference/Warnings.md, test/helper.js, test/options.error-handler.test.js, test/options.test.js, test/patch.error-handler.test.js, test/patch.test.js, test/put.error-handler.test.js, test/put.test.js, test/input-validation.js

- **fastify:ed4f4c1e2abe** — MRR 1.000, Recall@10 1.000
  subject: improve: dont cache unnecessary content types (#4134)
  task: improve: dont cache unnecessary content types
  gold: lib/contentTypeParser.js, test/content-parser.test.js
  top-ranked: lib/contentTypeParser.js, lib/reply.js, test/internals/contentTypeParser.test.js, fastify.js, lib/handleRequest.js, lib/pluginOverride.js, lib/pluginUtils.js, types/content-type-parser.d.ts, test/content-parser.test.js, test/internals/handleRequest.test.js

- **axios:ad68e1a484b5** — MRR 1.000, Recall@10 1.000
  subject: fix(http): honor timeout during connect without redirects (#10819)
  task: fix(http): honor timeout during connect without redirects * fix(http): honor connect timeout without redirects * fix(http): consolidate native timeout cleanup ---------
  gold: lib/adapters/http.js, tests/unit/adapters/http.test.js
  top-ranked: tests/unit/adapters/http.test.js, lib/adapters/http.js, tests/setup/server.js, tests/unit/adapters/fetch.test.js, tests/browser/cancel.browser.test.js, lib/adapters/xhr.js, lib/helpers/HttpStatusCode.js, lib/core/Axios.js, lib/core/mergeConfig.js, lib/helpers/resolveConfig.js

- **axios:f7a4ee21d5d6** — MRR 1.000, Recall@10 1.000
  subject: fix(http): closing detached http2 session on timeout (#7457)
  task: fix(http): closing detached http2 session on timeout
  gold: lib/adapters/http.js, test/unit/adapters/http.js
  top-ranked: lib/adapters/http.js, tests/unit/adapters/http.test.js, test/unit/adapters/http.js, tests/setup/server.js, test/helpers/server.js, index.d.cts, index.d.ts, README.md, lib/helpers/HttpStatusCode.js, tests/unit/adapters/fetch.test.js

## Environment / timing (non-deterministic section)

{"node":"v24.15.0","platform":"win32 10.0.26300","cpu":"AMD Ryzen 7 4800H with Radeon Graphics         ","totalMemGB":15.4}

timings (ms): {"snapshotMs":333651.26259999967,"indexMs":1801397.3100000003,"occMs":65606.03889999868,"baselinesMs":301993.6324000014}

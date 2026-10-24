# Retrieval Evaluation Results — TUNING SPLIT

Dataset hash `ec50ab4f` · 300 tasks · seed 20260918 · split **tuning** · OCC commit `821c5c8d5ef9` · working tree clean at run start: yes

## Overall (mean [95% bootstrap CI], per task)

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.460 [0.403, 0.517] | 0.508 [0.470, 0.548] | 0.628 [0.588, 0.665] | 0.390 [0.337, 0.447] | 0.602 [0.559, 0.647] |
| filename | 0.207 [0.160, 0.253] | 0.228 [0.188, 0.265] | 0.325 [0.282, 0.363] | 0.163 [0.123, 0.203] | 0.312 [0.268, 0.356] |
| bm25 | 0.293 [0.243, 0.350] | 0.427 [0.380, 0.475] | 0.592 [0.547, 0.636] | 0.373 [0.317, 0.430] | 0.460 [0.415, 0.502] |
| random | 0.030 [0.013, 0.050] | 0.041 [0.028, 0.055] | 0.089 [0.066, 0.111] | 0.023 [0.007, 0.043] | 0.098 [0.078, 0.120] |

OCC generated package: mean 25214 tokens, mean 14.9 files included per task.

## Source-only gold slice (OCC-fully-parsed gold)

Full gold: 865 gold files across 300 tasks. Source-only slice: 850 gold files across 300 tasks (0 tasks excluded for an empty slice).

| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.460 [0.403, 0.517] | 0.512 [0.473, 0.551] | 0.632 [0.593, 0.670] | 0.397 [0.343, 0.453] | 0.602 [0.559, 0.647] |
| filename | 0.203 [0.153, 0.247] | 0.227 [0.187, 0.264] | 0.324 [0.281, 0.362] | 0.163 [0.123, 0.203] | 0.307 [0.263, 0.350] |
| bm25 | 0.290 [0.240, 0.343] | 0.429 [0.382, 0.476] | 0.594 [0.550, 0.639] | 0.377 [0.320, 0.433] | 0.458 [0.414, 0.500] |
| random | 0.030 [0.013, 0.050] | 0.041 [0.028, 0.055] | 0.089 [0.067, 0.112] | 0.023 [0.007, 0.043] | 0.098 [0.078, 0.120] |

## Package recall (gold coverage of the delivered answer)

OCC = fraction of gold files inside the generated package (parsed from its `### FILE:` headings); baselines = Recall@8, matching OCC's mean package size.

| System | Package recall (mean [95% CI]) |
|---|---|
| occ | 0.595 [0.554, 0.635] |
| filename | 0.275 [0.235, 0.313] |
| bm25 | 0.534 [0.490, 0.580] |
| random | 0.079 [0.059, 0.102] |

## Paired bootstrap: OCC − BM25 per-task differences

### Full gold

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.167 [0.093, 0.240] | **yes** |
| recall5 | 0.081 [0.036, 0.132] | **yes** |
| recall10 | 0.036 [-0.007, 0.079] | no |
| allGoldAcc10 | 0.017 [-0.033, 0.070] | no |
| mrr | 0.142 [0.088, 0.194] | **yes** |
| packageRecall | 0.060 [0.013, 0.112] | **yes** |

### Source-only slice

| Metric | Mean diff (OCC − BM25) [95% CI] | Excludes 0 |
|---|---|---|
| top1 | 0.170 [0.100, 0.240] | **yes** |
| recall5 | 0.083 [0.038, 0.131] | **yes** |
| recall10 | 0.037 [-0.010, 0.083] | no |
| allGoldAcc10 | 0.020 [-0.037, 0.073] | no |
| mrr | 0.144 [0.092, 0.199] | **yes** |
| packageRecall | 0.061 [0.013, 0.113] | **yes** |

## All-gold gap analysis (BM25 all-gold in top 10, OCC not)

30 tasks, 47 missing gold files. Missing by type: ci-config=4, docs=7, other=1, source=18, test=17. Not in OCC's candidate set at all: 12. Median OCC rank of missing files: 34; median BM25 rank: 4.

- **axios:1de70bd13050**
  - examples/server.js (source): OCC rank 54, BM25 rank 10

- **axios:63f41b53aa45**
  - README.md (docs): OCC rank not in candidates, BM25 rank 7
  - examples/upload/index.html (other): OCC rank 50, BM25 rank 1

- **axios:83ae3830e407**
  - test/specs/interceptors.spec.js (test): OCC rank 12, BM25 rank 3

- **axios:af170334bdd0**
  - README.md (docs): OCC rank 34, BM25 rank 2

- **axios:e0b1bb6d0ba9**
  - Gruntfile.js (source): OCC rank 23, BM25 rank 1

- **axios:f40de498e6af**
  - karma.conf.js (source): OCC rank 11, BM25 rank 1

- **fastify:42ac663bb175**
  - docs/Server.md (docs): OCC rank not in candidates, BM25 rank 1
  - test/route-prefix.test.js (test): OCC rank 24, BM25 rank 3

- **fastify:84122c9e4b57**
  - test/listen.test.js (test): OCC rank 13, BM25 rank 1

- **fastify:978dd0c00bf1**
  - package.json (ci-config): OCC rank 21, BM25 rank 7

- **fastify:9eaa756deae8**
  - package.json (ci-config): OCC rank 29, BM25 rank 4

- **fastify:ac8fed4387d1**
  - test/custom-parser.test.js (test): OCC rank 13, BM25 rank 4

- **fastify:cdd259ee1628**
  - package.json (ci-config): OCC rank 17, BM25 rank 3

- **hono:4df4bb4b57a7**
  - deno_dist/jsx/dom/index.ts (source): OCC rank 11, BM25 rank 7
  - deno_dist/jsx/hooks/index.ts (source): OCC rank 40, BM25 rank 4
  - src/jsx/dom/index.test.tsx (test): OCC rank 39, BM25 rank 1
  - src/jsx/dom/index.ts (source): OCC rank 12, BM25 rank 6
  - src/jsx/hooks/index.ts (source): OCC rank 41, BM25 rank 3

- **hono:8b0f189a3fab**
  - deno_dist/middleware/pretty-json/index.ts (source): OCC rank not in candidates, BM25 rank 9
  - src/context.test.ts (test): OCC rank not in candidates, BM25 rank 6
  - src/middleware/pretty-json/index.ts (source): OCC rank 29, BM25 rank 8

- **hono:90da1961930b**
  - deno_test/middleware.test.tsx (test): OCC rank 17, BM25 rank 6

- **hono:9ef8f8528d0c**
  - src/router/reg-exp-router/router.ts (source): OCC rank 40, BM25 rank 5
  - src/utils/url.ts (source): OCC rank 36, BM25 rank 2

- **undici:075d80a89297**
  - lib/fetch/body.js (source): OCC rank 31, BM25 rank 4
  - test/client-fetch.js (test): OCC rank 51, BM25 rank 3

- **undici:1b858fbcaec4**
  - lib/websocket/receiver.js (source): OCC rank 49, BM25 rank 1

- **undici:221c81db894e**
  - test/client-pipelining.js (test): OCC rank 17, BM25 rank 7

- **undici:3d685b0df479**
  - test/client.js (test): OCC rank 14, BM25 rank 7

- **undici:9efbfb7fce41**
  - lib/client.js (source): OCC rank not in candidates, BM25 rank 6

- **undici:bd69341d538a**
  - lib/fetch/body.js (source): OCC rank 38, BM25 rank 1
  - test/fetch/client-fetch.js (test): OCC rank 36, BM25 rank 2

- **undici:fa6b2100a1b5**
  - lib/fetch/util.js (source): OCC rank 33, BM25 rank 2

- **zod:47091603204b**
  - README.md (docs): OCC rank not in candidates, BM25 rank 1
  - deno/lib/README.md (docs): OCC rank not in candidates, BM25 rank 2
  - deno/lib/__tests__/partials.test.ts (test): OCC rank 48, BM25 rank 8
  - src/__tests__/partials.test.ts (test): OCC rank 49, BM25 rank 7

- **zod:4e42ee315ad8**
  - deno/lib/README.md (docs): OCC rank not in candidates, BM25 rank 2

- **zod:6606b013dc83**
  - deno/lib/types.ts (source): OCC rank 63, BM25 rank 10
  - src/types.ts (source): OCC rank 65, BM25 rank 9

- **zod:827cb5d47af5**
  - deno/lib/__tests__/string.test.ts (test): OCC rank not in candidates, BM25 rank 2
  - src/__tests__/string.test.ts (test): OCC rank not in candidates, BM25 rank 1

- **zod:89a5334dc9e3**
  - deno/lib/__tests__/discriminatedUnions.test.ts (test): OCC rank 71, BM25 rank 9
  - src/__tests__/discriminatedUnions.test.ts (test): OCC rank 72, BM25 rank 8

- **zod:ab8a37191fa2**
  - README.md (docs): OCC rank not in candidates, BM25 rank 2

- **zod:c190a84bfe55**
  - package.json (ci-config): OCC rank not in candidates, BM25 rank 8

## Per repository

### axios (pinned e6b79d9cef79, MIT)
Mined 2036, accepted 540, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 11, non-localizable gold files excluded from accepted tasks: 83. Top rejections: bot-author=474, ci-only=117, docs-only=321, file-count=125, format-only=5.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.467 [0.350, 0.583] | 0.507 [0.412, 0.605] | 0.592 [0.496, 0.684] | 0.383 [0.267, 0.500] | 0.584 [0.481, 0.682] |
| filename | 0.217 [0.117, 0.317] | 0.191 [0.119, 0.271] | 0.241 [0.159, 0.327] | 0.100 [0.033, 0.183] | 0.292 [0.195, 0.397] |
| bm25 | 0.200 [0.100, 0.300] | 0.384 [0.277, 0.492] | 0.542 [0.445, 0.648] | 0.350 [0.233, 0.483] | 0.359 [0.271, 0.457] |
| random | 0.033 [0.000, 0.083] | 0.040 [0.013, 0.072] | 0.088 [0.042, 0.143] | 0.017 [0.000, 0.050] | 0.086 [0.048, 0.140] |

### fastify (pinned ce41dc0fbb4e, MIT)
Mined 4474, accepted 684, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 1, non-localizable gold files excluded from accepted tasks: 114. Top rejections: bot-author=988, ci-only=237, docs-only=1010, file-count=133, format-only=21.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.433 [0.300, 0.567] | 0.509 [0.420, 0.597] | 0.621 [0.543, 0.702] | 0.333 [0.217, 0.450] | 0.614 [0.514, 0.707] |
| filename | 0.150 [0.067, 0.250] | 0.234 [0.164, 0.312] | 0.268 [0.198, 0.341] | 0.083 [0.017, 0.167] | 0.301 [0.222, 0.384] |
| bm25 | 0.283 [0.183, 0.400] | 0.392 [0.297, 0.488] | 0.532 [0.431, 0.626] | 0.300 [0.183, 0.417] | 0.449 [0.361, 0.546] |
| random | 0.033 [0.000, 0.083] | 0.040 [0.014, 0.071] | 0.086 [0.045, 0.134] | 0.017 [0.000, 0.050] | 0.114 [0.070, 0.165] |

### hono (pinned 5ca49b072075, MIT)
Mined 2803, accepted 1181, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 4, non-localizable gold files excluded from accepted tasks: 158. Top rejections: bot-author=458, ci-only=101, docs-only=106, file-count=191, format-only=7.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.317 [0.217, 0.433] | 0.491 [0.392, 0.584] | 0.655 [0.560, 0.744] | 0.450 [0.317, 0.567] | 0.504 [0.411, 0.598] |
| filename | 0.367 [0.250, 0.483] | 0.476 [0.376, 0.586] | 0.581 [0.483, 0.686] | 0.383 [0.267, 0.517] | 0.498 [0.396, 0.604] |
| bm25 | 0.317 [0.183, 0.450] | 0.420 [0.324, 0.513] | 0.561 [0.467, 0.646] | 0.333 [0.217, 0.450] | 0.492 [0.385, 0.598] |
| random | 0.017 [0.000, 0.050] | 0.021 [0.003, 0.043] | 0.054 [0.024, 0.092] | 0.000 [0.000, 0.000] | 0.060 [0.031, 0.101] |

### undici (pinned 1f452240899a, MIT)
Mined 4353, accepted 1449, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 2, non-localizable gold files excluded from accepted tasks: 305. Top rejections: bot-author=1101, ci-only=102, docs-only=210, file-count=166, format-only=6.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.433 [0.317, 0.550] | 0.495 [0.393, 0.595] | 0.662 [0.569, 0.754] | 0.500 [0.367, 0.617] | 0.546 [0.452, 0.647] |
| filename | 0.217 [0.117, 0.317] | 0.162 [0.089, 0.239] | 0.394 [0.294, 0.493] | 0.233 [0.133, 0.350] | 0.289 [0.196, 0.389] |
| bm25 | 0.400 [0.283, 0.533] | 0.564 [0.450, 0.669] | 0.709 [0.611, 0.805] | 0.550 [0.417, 0.683] | 0.548 [0.449, 0.650] |
| random | 0.017 [0.000, 0.050] | 0.079 [0.034, 0.128] | 0.161 [0.087, 0.236] | 0.083 [0.017, 0.167] | 0.113 [0.071, 0.161] |

### zod (pinned afdac65e0f80, MIT)
Mined 2935, accepted 494, sampled 60, evaluated 60 (dropped for empty effective gold: 0; tasks with partially dropped gold: 0; gold files dropped by mode: symlink 0, gitlink 0, missing 0), duplicates 8, non-localizable gold files excluded from accepted tasks: 70. Top rejections: bot-author=565, ci-only=128, docs-only=488, file-count=183, format-only=44.
| System | Top-1 | Recall@5 | Recall@10 | AllGold Acc@10 | MRR |
|---|---|---|---|---|---|
| occ | 0.650 [0.533, 0.767] | 0.540 [0.464, 0.620] | 0.608 [0.532, 0.685] | 0.283 [0.167, 0.400] | 0.762 [0.669, 0.849] |
| filename | 0.083 [0.017, 0.150] | 0.078 [0.038, 0.123] | 0.141 [0.090, 0.199] | 0.017 [0.000, 0.050] | 0.179 [0.113, 0.257] |
| bm25 | 0.267 [0.150, 0.383] | 0.376 [0.294, 0.456] | 0.615 [0.524, 0.702] | 0.333 [0.217, 0.450] | 0.450 [0.356, 0.544] |
| random | 0.050 [0.000, 0.117] | 0.026 [0.009, 0.045] | 0.054 [0.027, 0.082] | 0.000 [0.000, 0.000] | 0.117 [0.065, 0.185] |

## Case studies (OCC)

### Worst 5 failures (lowest MRR)

- **hono:128970e2d221** — MRR 0.000, Recall@10 0.000
  subject: chore: move under `honojs` organization (#178)
  task: chore: move under `honojs` organization
  gold: README.md, docs/README.ja.md, examples/compute-at-edge/package.json, examples/jsx-ssr/src/components/footer.tsx, package.json, src/middleware/mustache/README.md, src/middleware/serve-static/README.md
  top-ranked: src/router/reg-exp-router/router.test.ts, src/hono.ts, src/router/trie-router/node.ts, src/router/trie-router/router.ts, src/utils/url.ts, src/router.ts, src/router/reg-exp-router/router.ts, src/compose.ts, src/context.ts, src/index.ts

- **hono:a104bf0010ba** — MRR 0.000, Recall@10 0.000
  subject: fix(netlify): fix import paths (#1304)
  task: fix(netlify): fix import paths
  gold: deno_dist/adapter/netlify/handler.ts, deno_dist/adapter/netlify/mod.ts, src/adapter/netlify/handler.ts, src/adapter/netlify/mod.ts
  top-ranked: src/utils/url.ts, deno_dist/utils/url.ts, deno_dist/hono-base.ts, src/hono-base.ts, src/utils/url.test.ts, src/hono.test.ts, deno_dist/router/reg-exp-router/router.ts, src/router/reg-exp-router/router.ts, src/types.test.ts, src/adapter/aws-lambda/handler.ts

- **zod:6606b013dc83** — MRR 0.000, Recall@10 0.000
  subject: Roll back all early abort changes
  task: Roll back all early abort changes
  gold: deno/lib/types.ts, src/types.ts
  top-ranked: deno/lib/__tests__/error.test.ts, src/__tests__/error.test.ts, deno/lib/ZodError.ts, deno/lib/__tests__/anyunknown.test.ts, deno/lib/__tests__/array.test.ts, deno/lib/__tests__/base.test.ts, deno/lib/__tests__/crazySchema.ts, deno/lib/__tests__/default.test.ts, deno/lib/__tests__/enum.test.ts, deno/lib/__tests__/firstparty.test.ts

- **zod:5f84473deb54** — MRR 0.000, Recall@10 0.000
  subject: Add default export in mod.ts
  task: Add default export in mod.ts
  gold: deno-build.mjs, deno/lib/README.md, deno/lib/mod.ts
  top-ranked: deno/lib/types.ts, src/types.ts, package.json, configs/babel-jest.config.json, configs/ts-jest.config.json, configs/jest.config.json, jest.config.json, deno/lib/__tests__/default.test.ts, src/__tests__/default.test.ts, deno/lib/__tests__/catch.test.ts

- **undici:9efbfb7fce41** — MRR 0.000, Recall@10 0.000
  subject: fix: removed no longer relevant note
  task: fix: removed no longer relevant note
  gold: lib/client.js
  top-ranked: (empty)

### Best 5 successes (highest MRR)

- **fastify:92f106a7b083** — MRR 1.000, Recall@10 1.000
  subject: fix(internals): fix typo in handleRequest (#2240)
  task: fix(internals): fix typo in handleRequest Add missing `raw` property in path when accessing `writableEnded`. Explicitly set `writableEnded` only in Node versions greather than equal to 12.9.0 in `preValidationCallback` test.
  gold: lib/handleRequest.js, test/internals/handleRequest.test.js
  top-ranked: lib/handleRequest.js, test/internals/handleRequest.test.js, fastify.js, lib/route.js, lib/reply.js, lib/logger.js, test/internals/contentTypeParser.test.js, lib/contentTypeParser.js, lib/pluginUtils.js, lib/validation.js

- **fastify:c4eb4267c533** — MRR 1.000, Recall@10 1.000
  subject: Simplify schemaErrorsText builder function (#1412)
  task: Simplify schemaErrorsText builder function * Simplify schemaErrorsText builder function * Remove unnecessary null check
  gold: lib/validation.js
  top-ranked: lib/validation.js, lib/decorate.js, lib/pluginUtils.js, fastify.js, test/internals/handleRequest.test.js, lib/reply.js, lib/contentTypeParser.js, lib/handleRequest.js, test/internals/plugin.test.js, lib/wrapThenable.js

- **fastify:889f16dcbf7f** — MRR 1.000, Recall@10 1.000
  subject: Fix missing object wrapper for errors in pino log (#1180)
  task: Fix missing object wrapper for errors in pino log log is a pino logger, the first argument is a mapping, so in order to give it an error object, we must give it an object with an 'err' field. This commit fixes places where this has been forgotten, except in test files.
  gold: fastify.js, lib/reply.js, lib/wrapThenable.js
  top-ranked: fastify.js, lib/reply.js, test/internals/handleRequest.test.js, test/internals/contentTypeParser.test.js, lib/wrapThenable.js, lib/handleRequest.js, lib/request.js, lib/hookRunner.js, lib/validation.js, lib/schemas.js

- **fastify:015480adf8b4** — MRR 1.000, Recall@10 1.000
  subject: Added deprecation warning for genReqId option in logger (#1166)
  task: Added deprecation warning for genReqId option in logger
  gold: fastify.js
  top-ranked: fastify.js, lib/logger.js, lib/reply.js, lib/validation.js, test/internals/handleRequest.test.js, lib/request.js, lib/handleRequest.js, lib/wrapThenable.js, docs/Server.md, lib/reqIdGenFactory.js

- **fastify:13011ce6f8f0** — MRR 1.000, Recall@10 1.000
  subject: Simplify building Hooks and ContentTypeParser
  task: Simplify building Hooks and ContentTypeParser Creating a new constructor and inheriting from the old one isn't necessary for Hooks and ContentTypeParser. Simply creating a new instance and cloning the values is all that's needed. This also improves debugging, general code compatibility, and possibly…
  gold: lib/ContentTypeParser.js, lib/hooks.js
  top-ranked: lib/hooks.js, lib/ContentTypeParser.js, lib/logger.js, fastify.js, lib/reply.js, lib/handleRequest.js, lib/validation.js, test/internals/handleRequest.test.js, lib/errorUtils.js, lib/pluginUtils.js

## Environment / timing (non-deterministic section)

{"node":"v24.15.0","platform":"win32 10.0.26300","cpu":"AMD Ryzen 7 4800H with Radeon Graphics         ","totalMemGB":15.4}

timings (ms): {"snapshotMs":2936998.5421,"indexMs":284695.85000000056,"occMs":32640.105299997842,"baselinesMs":52269.63060000099}

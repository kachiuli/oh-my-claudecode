# Workflow V1.2 validation

Status: **integrated local checks and bounded live Claude worker/review checks pass;
read-only enforcement evidence is partial and broader adoption remains pending**.
This is a new report. Historical [V1](GLM-WORKFLOW-VALIDATION.md) and
[V1.1](GLM-WORKFLOW-V1.1-VALIDATION.md) observations remain bound to their original
sources and are not replaced by this document. See the
[V1.2 setup guide](GLM-WORKFLOW-V1.2.md) and
[acceptance plan](ROLE-SUBSTITUTION-TEST-PLAN.md).

## Source observations already completed

| Packet | Exact source | Actual local result | Practical limit |
| --- | --- | --- | --- |
| P1 versioned contracts | `203fd6c3544c96d5c54551e19e2ccdbd60b5135d` | Build and lint passed; 9 workflow files, 206 tests passed, no pending tests. | R01/R11/R13 contract portions; parser tests do not prove controller or continuation behavior. |
| P3 telemetry/reporting | `b310c6b8cb5fd2071de729e15065cf34bc70a29b` | Build and lint passed; 9 workflow files, 221 tests passed, no pending tests. Includes 15 new Claude usage and V2 report cases. | R15/R19 local usage portions; no authenticated adapter or integrated status proof. |
| Provider-compatible review schema successor | Integrated as `ce13a91de574bb40038127a65488f44d5f3731ce` | Included in the final combined run below; 44 review-path cases pass. | Its 3 added cases are not retroactively added to P3's 221-test observation. |
| P2 runtime/adapters | `ec9949f232ed746d22047bf44fa33e448936eb0a`, integrated as `264a663c10a5b520f4ed740b75791da06acd5dad` | Final combined run covers 11 workflow files and 285 passing cases, including the final reviewer-context correction. | Authenticated CLI restriction enforcement remains unproved. |
| P4 CLI/setup | Scoped CLI/docs changes on `264a663c10a5b520f4ed740b75791da06acd5dad` | Final combined run covers 5 CLI files and 111 passing cases. Initial CLI RED: 6 failed, 33 passed. | New route dispatch uses mocked controller APIs in 46 cases; 3 additional cases use the actual controller with no provider call. |

P3 retained its discriminating RED/green logs. The original report dropped normal
Claude and inferred provider work from task/review roles; the corrected report
uses each saved binding. Two newly written assertions initially expected absent
properties instead of serialized unknown counters, and the first full build
found a legacy session type inherited by a V2 test fixture. Both test-fixture
corrections and first failures were preserved. They were not provider failures.

Source-only commits omit generated runtime output. Packet evidence records exact
command arrays, UTC times, exits, source and lock hashes, test JSON, and generated
CLI/module hashes at each observation. Rebuilding later does not change which
binary or source an older observation verified.

## Final integrated local run

The coherent final-source run on 2026-09-15 completed the full build at
10:55:49 UTC, the combined test run at 11:00:45 UTC and full `npm run lint` at
11:01:15 UTC. All exited zero. The tests report **16 files, 396 passing cases,
zero failures and zero pending/skipped cases**. This is the selected workflow/CLI
test scope, not the entire repository test suite. The 1,380 captured source and
configuration files were byte-identical before and after these checks.

| Test file under `src/` | Passing cases |
| --- | ---: |
| `team/__tests__/workflow.test.ts` | 37 |
| `team/__tests__/workflow-contracts.test.ts` | 16 |
| `team/__tests__/workflow-balanced.test.ts` | 24 |
| `team/__tests__/workflow-process.test.ts` | 26 |
| `team/__tests__/workflow-routing.test.ts` | 4 |
| `team/__tests__/workflow-report.test.ts` | 7 |
| `team/__tests__/workflow-usage.test.ts` | 48 |
| `team/__tests__/workflow-review-paths.test.ts` | 44 |
| `team/__tests__/workflow-state-v2.test.ts` | 18 |
| `team/__tests__/workflow-adapters.test.ts` | 51 |
| `team/__tests__/workflow-adapter-process.test.ts` | 10 |
| `cli/commands/__tests__/team-workflow.test.ts` | 46 |
| `cli/commands/__tests__/team-workflow-v12.test.ts` | 3 |
| `cli/commands/__tests__/team.test.ts` | 49 |
| `cli/commands/__tests__/team-role-shorthand.test.ts` | 4 |
| `cli/commands/__tests__/doctor-team-routing.test.ts` | 9 |

The actual-controller CLI cases initialize V1/V2 explicitly, verify status/usage
do not rewrite saved bytes, and reject a synthetic capability receipt through the
normal CLI before reserving an invocation. Synthetic repositories and their
receipts are retained. They contain no actual provider credentials, and they do
not establish authenticated model identity or Claude permission enforcement.

The built absolute CLI's `team workflow --help` exits zero and lists the new
profile, bindings, private runtime and substitution options. It also emits the
existing native-Windows tmux warning and Node `DEP0190`; this is not a
console-clean claim or a reason to add a shell provider adapter. The explicit
workflow controller does not require the ordinary tmux team runtime. No unrelated
warning or platform code was changed in this packet.

Build artifact SHA-256 observations:

| Artifact | SHA-256 |
| --- | --- |
| `bridge/cli.cjs` | `657acf892a5036d7a990e3d63c9a2d731ea814be5e67adc71470731a9dcdd56b` |
| `dist/team/workflow-contracts.js` | `e6af0fda69dede23415bd3daf3dba1e986a857a98642907ae59b82cdc7727501` |
| `dist/team/workflow-adapters.js` | `900ce22109baab5df37765649992f27da9225a47e69c791e25284052e8f98d59` |
| `dist/cli/commands/team-workflow.js` | `81aa7801b357d3b0bd944d8493de82dfc87b4c6c098be7a18267e0cb6ab22bc5` |

The candidate's ignored `.tmp/workflow-v1.2-p4` packet retains exact argument
arrays, logs, test JSON and before/after source manifests. This report is a safe
summary; it does not publish private runtime configuration. Documentation status
was refreshed after checks without changing source or generated binaries.

## Bounded live observations, 2026-09-15

A separately authorized synthetic-source probe ran against source
`d56c2b9196a99860c5f9c1f0427a79128cfc1f99` and the built CLI/contracts hashes
listed above. It used native Windows, Node `24.18.1` and Claude Code `2.1.258`.
The harness exercised the compiled controller and operation adapters; it does
not independently establish every CLI/private-config entry path.
The workflow was a new balanced, schema-2 `role-substitution` fixture with one
worker and one review pass. Exactly **three authenticated Claude calls** ran:
one worker, one fresh reviewer and one separate restriction challenge. There
were no automatic retries, hidden provider changes or resets of an old run.

| Check | Observed result | Limit |
| --- | --- | --- |
| L01 normal Claude worker | **PASS for the bounded task.** One owned `src/clamp.mjs` commit, exact structured handoff, controller check replay, explicit root acceptance and integrated verification passed. | One task/connection/version; not a general worker, multi-worker or session-continuation certification. |
| L02 normal Claude reviewer | **PASS for structured review execution.** A fresh restricted invocation returned the real seeded access-control defect and two additional notes; normal parser and adjudication accepted the result. Source and refs remained unchanged. | Successful structured review does not establish effective write/command denial; see L03. No authenticated reviewer capability receipt was promoted. |
| L03 restriction challenge | **PARTIAL.** Requested command/write tools were absent, the structured response completed and tracked/untracked fixture files plus refs remained unchanged. | No actual runtime denial event was observed. Cooperative refusal and final equality cannot prove that attempted writes or command execution were prevented. |
| L04 explicit replacement after unavailable command | **PASS for the bounded replacement.** A deliberately absent local executable produced a preserved preflight failure with zero provider calls/attempts; root explicitly selected the normal Claude binding before the one worker call. | This did not simulate an authenticated provider outage or prove cross-provider session reuse. No attempt budget was reset. |
| L05 external lead | **Observed external-root lead operation.** The authenticated Codex root recorded the bounded plan, explicitly accepted/verified the worker, inspected the review and adjudicated findings. | System context identifies GPT-6; an independently observed exact model slug was unavailable and remains `unknown`. The controller did not launch or certify a Codex implementation adapter. |

The worker commit was `5c1f8874b6b8c13d97cf502b8d352257c167b212`; accepted
integration was `5c668c86ac00c88256c95897d2e4f3c853c60775`. All six frozen
clamp cases passed through the actual exact-command controller replay and
integrated check: below/inside/above bounds, equal bounds, reversed bounds and
nonfinite input. These cases do not claim coverage of the separately seeded
access module, nor every argument-validation combination in the implementation.

The reviewer correctly identified the deliberate inverted ownership comparison
at `src/access.mjs:2`, noted missing access tests, and disclosed that it had not
executed tests itself. Root recorded **fix / fix / dismiss**: retain the seeded
defect and missing coverage for correction, and dismiss the execution-limit
note as a limitation rather than a code defect. The fixture remains in
`remediation`, with two unresolved findings. It was not finished or presented
as completed product work. The P0 label describes an intentionally seeded
synthetic defect, not a discovered production vulnerability.

### Model, usage and profile evidence

All three calls explicitly requested `claude-fable-5-1[1m]` with effort `high`
on the normal first-party Claude connection. The main-response model observed
was `claude-fable-5-1`; the request modifier is not independent proof of effective
context capacity. CLI usage also contained the ancillary key
`claude-haiku-4-5-20251001`. That key is included in all-model accounting and
does not, by itself, establish replacement of the requested primary model.
Effective effort was not independently measured.

| Call | Telemetry | Input, including cached input | Output | Cache read | Cache write |
| --- | --- | ---: | ---: | ---: | ---: |
| Worker | measured, all models | 186,728 | 5,400 | 165,543 | 19,336 |
| Fresh review | measured, all models | 19,005 | 1,947 | 7,868 | 9,290 |
| Separate challenge | measured, all models | 14,961 | 718 | 12,736 | 1,148 |

These are CLI-reported observations, **not measured savings or billing**. The
challenge was outside the workflow's worker/review ledger; it is the third
provider call, not an extra saved workflow review pass. Missing future usage
must still remain unknown.

The requested review tools were `Read,Glob,Grep`, with restricted/safe mode,
`dontAsk`, empty strict MCP configuration and no session persistence. The actual
tool inventory also advertised `StructuredOutput`, the harmless structured-result
protocol tool. The draft challenge classifier treated any extra tool as unsafe;
that broad classification does not mean this protocol tool can modify source.
Actual reviewer/challenge tool-use events were `Read` and `StructuredOutput`.
Even after accounting for that distinction, **L03 remains partial because the
denial-event list is empty**. No runtime/adaptor change or authenticated reviewer
receipt is justified by interpreting the challenge as a full pass.

Protected normal-Claude auth/profile guards stayed unchanged throughout. The
user-wide `.claude.json` mutable metadata changed during the calls, so this is
not a claim that every Claude-owned file stayed byte-identical. No profile
change, copied credential or GLM-route substitution was performed. Fresh review
provenance remained `unknown`; shared provider/account identity neither proves
independence nor forbids self-review.

The retained ignored packet is
`.tmp/workflow-v1.2-live-preparation/runs/claude-v12-20260915`, with launch
descriptors, attempt/outcome records, raw bounded process evidence, the fixture
and root decisions. Launch descriptors alone were preparation, not proof of
execution; the completed process/controller receipts supply the observations.
The controlled bootstrap used retained synthetic capability receipts. Root then
explicitly approved a new **worker-only authenticated capability** from the
observed evidence. Its normal binding preflight passed without a synthetic
bypass, additional provider call or workflow-state mutation. This local approval
covers the observed normal-Claude `structured-handoff` operation only; future
selection still checks current executable/auth identity. It grants no reviewer,
read-only, session-resume or ancillary-model capability. No authenticated
reviewer receipt was promoted. Original bootstrap/draft artifacts are preserved;
credentials and private transcripts are not published in this report.

| Retained outcome under the packet | SHA-256 |
| --- | --- |
| `evidence/worker.outcome.json` | `b28c1ab5f2c058ca02714a256bbfa9aecb1ba090958ff48152fe38753f9ded71` |
| `evidence/accept-verify.outcome.json` | `c77349a420c57ba736698cb0b92bafb9078973f13b3df6ef5d3caa955cfdee05` |
| `evidence/review.outcome.json` | `45fe741a650596cbebd06364cc7e32028aea7ce72a8702e8f1be41447a8384ee` |
| `evidence/challenge.outcome.json` | `197bc0e1fbceb6febd0e27cce07b2a773a8657b3712a303a684fa54df1ee5d5a` |
| `evidence/adjudicate.outcome.json` | `920db01cbb23b5862ac3bc8685427601a281c932743b2c2fbb106be903f2c169` |

## Remaining acceptance evidence

- Lead adoption of the source-only packet and explicit runner selection. Old
  saved runs retain their original binaries and evidence.
- Lead assessment of the implemented scenarios against the acceptance plan.
  Synthetic adapter fixtures verify ownership, protocol, counters and detection
  of attempted mutations; they cannot prove an actual CLI prevents those writes.
- Independent/self-review/unknown provenance as observed. Independence is
  preferred, not mandatory; same-session review remains unsupported unless its
  adapter and permission transition are separately established.
- Actual runtime denial evidence for L03, and any broader route/profile,
  multi-worker or continuation claims beyond the bounded live observations
  above. A successful structured review is not an authenticated read-only
  capability certificate; the synthetic tests and local help cannot close it.
- Lead adoption decision and any project-specific consumer pin/helper checks.
  No npm release, tag, publication or project-main acceptance is implied.

No authenticated call, provider profile change or old saved-run mutation was
performed as part of the original P3/P4 packets. The separately authorized live
observations above do not rewrite those reports or the earlier preserved review
schema incident. This remains a controlled local candidate, not a generally
release-verified workflow, published version or completed project checkpoint.

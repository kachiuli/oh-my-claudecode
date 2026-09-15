# Workflow V1.2 validation

Status: **integrated local checks pass; authenticated compatibility and adoption pending**.
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

## Remaining acceptance evidence

- Lead adoption of the source-only packet and explicit runner selection. Old
  saved runs retain their original binaries and evidence.
- Lead assessment of the implemented scenarios against the acceptance plan.
  Synthetic adapter fixtures verify ownership, protocol, counters and detection
  of attempted mutations; they cannot prove an actual CLI prevents those writes.
- Independent/self-review/unknown provenance as observed. Independence is
  preferred, not mandatory; same-session review remains unsupported unless its
  adapter and permission transition are separately established.
- Bounded authenticated compatibility observations L01–L05, especially the
  normal Claude reviewer flags, structured terminal envelope and effective
  read-only restriction challenge. Synthetic fixtures and local help do not
  substitute for those observations.
- Lead adoption decision and any project-specific consumer pin/helper checks.
  No npm release, tag, publication or project-main acceptance is implied.

No authenticated call, provider profile change or old saved-run mutation was
performed as part of P3 or this P4 packet. The earlier live
review schema rejection remains a separate preserved incident; a local schema
correction is not evidence that a later live review succeeded.

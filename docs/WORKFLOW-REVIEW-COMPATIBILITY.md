# Workflow review compatibility

Administrative adoption authorizes a complete source set for one final PR base/head pair. It consumes no review pass and changes no saved plan, option, role binding, pin, budget or history. Normal operation, lead authority, lease, authorship and review gates still apply.

The public adoption input carries an immutable manifest descriptor: absolute path, schema version, byte count, record count and SHA-256. The manifest contains one JSON string path per line in strict ascending order. Membership is checked against committed tracked paths for the authorized pair. Review selection restates the adopted descriptor; arrays, omissions, additions, duplicates, traversal and symlink escapes are refused. Legacy array inputs outside this compatibility selection retain their existing behavior.

## Complete source and bounded delivery

The controller freezes the complete authorized files, ancestor and nested governing AGENTS.md/CLAUDE.md instructions, inventory, binary Git diff, objective, shared context and task contracts. Empty materials remain explicit objects. Unicode and binary bytes survive chunk boundaries. The disk bundle has a constant descriptor, canonical streamed manifest, index, individual metadata records and immutable material files. It retains no inventory-sized entry array.

The MCP surface contains only `review_source_manifest` and `review_source_entry`. Requests name bundle-local IDs and opaque continuation cursors. Each page uses positioned reads and bounded metadata lookup. Every serialized response, including errors and tools/list, fits 8192 bytes **including its newline**. An identifier that cannot fit a correlated response closes the transport. Working buffers are bounded at 65536 bytes; these are per-buffer limits, not total-source ceilings.

Claude receives strict per-invocation MCP configuration. Synthetic Codex receives per-invocation TOML overrides and a projected copy of the host's complete model catalog. Native Codex receives two controller-owned app-server dynamic functions with environment access disabled. The native catalog changes only the selected model's tool mode and clears its experimental tool declarations; every other model field and record is preserved. Ordinary reviewer arguments remain unchanged when compatibility is absent.

## Runtime authority

Synthetic observation and an explicitly bootstrapped native Codex route are supported. The native route accepts only authenticated `gpt-6.1-sol`/`ultra` on the qualified Windows CLI `0.159.1`, SHA-256 `1203922d910426522182b35a52402085d0955101bb585a87bd7c88110d8d68d8`. Another executable, version, model or effort requires separate implementation and qualification. Requested `ultra` is preserved in CLI/thread/turn controls; this CLI emits wire reasoning effort `xhigh`, which is checked on every traced inference request.

Saved `readerObservation` and `readerQualification` records are historical consistency guards. Their labels, tool inventories, actor IDs, ledger paths and matching hashes confer no authority. CLI JSON cannot create the required runtime capability.

An explicit controller runtime first builds the fixed synthetic reviewer, reader and bridge capsule. The producer owns the source templates, compiler recipe, input/output hashes and closed dependency provenance. It refuses unsupported loaders and unresolved external dependencies. A private WeakMap brands the resulting build capability. The factory accepts only this capability, binds the selected role/profile and working directory, and owns the actual live reader connection. Lookalike objects and arbitrary executable paths are refused.

Native setup calls `qualifyWorkflowNativeReviewClientFactory` from the same built module tree as `prepareWorkflowBinding`. Preparation privately brands its returned object; a copied object, copied receipt or changed environment is refused. A freshly authenticated preparation may match the retained immutable binding snapshot. Bootstrap discovers inherited MCP server names before creating a model thread, disables every discovered name, and checks that any retained configuration metadata exposes no tools or resources and has no active runtime. Such metadata is not an inventory claim. Authority comes from the complete native model-facing inventory: exactly the two reader functions, checked before accepting any calibration or review.

Bootstrap runs a real authenticated calibration over fixed Unicode/escape, binary, multi-page and empty materials. The first completed turn must receive the manifest and nonempty source bytes; a supported `thread/compact/start` then completes a distinct compaction turn on the same thread. A following reader turn must consume another nonempty source page in a successful inference, then finish the original source through all empty terminal pages. Normal inference requests preserve the qualified schema, model and effort; the supported warmup and compact requests carry no output schema. The native projection preserves the selected qualified catalog context window of 272000, fixes auto-compaction at 98304 with `body_after_prefix`, and sets `analytics.enabled=false`. It returns a runtime-only WeakMap capability only after complete source reconstruction, proven compaction ancestry, successful corresponding model inference and actual protected process settlement. The resulting qualification JSON and native proof are diagnostic artifacts; reading them cannot recreate the capability. Every later review revalidates the binding, profile/environment identity, cwd, schema, catalog, source/dependency closure and sealed calibration evidence, then independently proves its own complete delivery.

An explicit controller can bootstrap and review as follows, using an existing validated runtime and reviewer binding:

```ts
const prepared = prepareWorkflowBinding(binding, runtime);
const catalog = projectWorkflowReviewCodexCatalog({ source: catalogSource,
  path: catalogPreviewPath, model: binding.model, preview: true, native: true });
const factory = await qualifyWorkflowNativeReviewClientFactory({ prepared, cwd,
  directory: newPrivateBootstrapDirectory, catalogSource,
  expected: workflowReviewProspectiveInvocation(binding, 'codex', catalog),
  schema: reviewReviewerResultSchema(true),
  transport: { certificates: absolutePrivateCertificateDirectory } });
try {
  runtime.nativeReviewClientFactory = factory;
  runtime.readerObservation = { mode: 'native', tools: [...WORKFLOW_REVIEW_READER_TOOLS] };
  await reviewWorkflow(cwd, name, runtime, { compatibility: { requestId, descriptor } });
} finally {
  await disposeWorkflowNativeReviewClientFactory(factory);
}
```

These functions are exported by `dist/team/workflow-adapters.js`, `dist/team/workflow-review-source-server.js` and `dist/team/workflow.js`. The bootstrap directory must be new and private. The absolute certificate directory holds the private CA certificate, leaf certificate and leaf key required by the native observer. The factory keeps the same held certificates, listener port and proxy secret across calibration and sequential reviews, while each invocation has separate held bodies, journal, trace and source pins. Native bootstrap requires the built-in `tls.getCACertificates` and `zlib.createZstdDecompress` APIs; ordinary imports and provider defaults remain compatible with Node 20. Calibration consumes no saved workflow review pass; the actual review retains the original operation, lease, adoption, verification, authorship and budget gates.

Synthetic setup refuses Node inline evaluation, short preload flags, import/loader hooks, and relative or package-name preloads. An absolute canonical JS/CJS `--require` entry is supported only when its checked syntax is a closed literal warning filter that forwards `process.emit`; the actual opened entry is hashed independently of package-tree traversal. Additional executable syntax is refused. The mandatory reviewer configuration is derived from the actual prepared environment and held-file checked before projection or reservation.

Before any per-review artifact or reservation, the controller prepares the role binding once and allocates the actual invocation, schema, result, catalog, bundle, receipt and relay paths. It derives and freezes the complete launch. Qualification binds the real command, arguments, working directory, environment identity, model, effort, authentication fingerprint, Node interpreter, protected process behavior, Windows supervisor and runtime/dependency closure. Revalidation occurs before the same prepared launch executes. Credential bodies and raw environment values are not written to evidence.

## Received bytes and retained proof

The synthetic reviewer initiates initialize, tools/list and every reader call through its private bridge. The controller records original request and response frames before parsing. The closed bridge acknowledges each response's original bytes before returning that response to the reviewer. Acknowledgements are private transport messages, separate from MCP stdout. SDK write/drain completion alone is not acknowledgement.

Native reception joins held outgoing HTTP/WSS wire and decoded request bodies, selected incoming EOF-complete typed response receipts, and the pinned CLI's [local rollout trace](https://github.com/openai/codex/tree/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/rollout-trace). The private observer forwards only fixed official ChatGPT routes with frozen upstream TLS roots. Incoming response bodies, authentication headers and metadata bodies are not retained. A served result or completed tool event is insufficient: its exact returned text must appear under the matching call ID in a later model-facing inference request with a successful completion. A warmup has zero source credit. A delta inherits omitted history only through the exact preceding successful response and supported full baseline. Automatic and manual compaction require exact input ancestry, opaque output receipts, installed checkpoints and the supported following baseline. Unknown tools, code-mode execution, missing transactions/payloads, altered bytes, failed inference, HTTP fallback, foreign ancestry or unverified compaction refuse findings. Unrelated history and metadata are stream-skipped without a total string, source or history ceiling; only required bounded tool declarations, arguments and reader outputs are retained.

Native reader pages are fitted against the exact app-server response envelope, including repeated JSON escaping and the newline, then guarded again at 8192 bytes. The direct native process uses the existing protected process supervisor and a bounded duplex input callback. Its ordinary stdout/stderr diagnostic copies are omitted; the controller retains only selected protocol frames needed for original reader custody and lifecycle checks. Privately branded observer completion and the exact actual protected-process result are required along with complete transport EOF, native trace evidence and source reconstruction.

Every correlation binds invocation, reviewer, effective launch, sequence, exact request ID and type, tool, arguments and cursor. UTF-8 decoding is strict and stateful; malformed, incomplete, oversized, trailing, unexpected or late frames poison the session. Outstanding and future calls fail after transport failure. Child close promises are installed immediately and actual reader/socket/listener closes are joined on every terminal path.

Original frames and correlation JSONL are retained separately from reconstructed material files and whole-object proof JSONL. Evidence files must be contained regular single-link files, with canonical ancestors and opened-handle identity. Empty objects require an acknowledged terminal zero-byte page, an actual empty reconstruction and a proof record. Fresh revisits of already reconstructed bytes are legal.

Only the private live session can mint a completion handle. Before admitting synthetic findings, the controller consumes that handle and independently replays request/response/ACK bytes into a second reconstruction. Native findings require replay of the model-facing payloads against original request/response custody, complete reconstruction and sealed payload references. The reader's intended receipt ledger and immutable source hashes are checked separately. Empty terminal pages are mandatory; `ranges` counts returned pages with nonzero material bytes. No reviewer-writable observed ledger is accepted as delivery authority.

Integrity failure preserves the provider's actual exit and process outcome, records a bounded specific diagnostic, and refuses findings as `workflow_review_process_failed`. A provider that exits zero can still fail delivery integrity. No timeout result or fabricated exit replaces the actual close result.

## Verification

The source regressions exercise bounded parsing, legacy scalar and array inputs, trailer/envelope rules, binary and Unicode round trips, empty terminal pages and revisits, owned file custody, strict raw IDs, errors/refusals, deliberately split UTF-8 and actual stdio close.

The public scale regression commits more than 100000 tiny paths, streams a disk manifest through adoption and freeze, reopens the published bundle and walks the real SDK reader pages. Expected membership and proof records are streamed from disk. Fixed scalar counters measure retained records, file descriptors, bounded buffers and positioned reads; no inventory-sized receipt or expected-path array, generic quota or heap census is used.

Synthetic regression evidence does not qualify a native host. Acceptance of a particular source revision still requires fresh checks, actual authenticated native qualification/review and independent assessment; documenting the supported route is not a release acceptance claim.

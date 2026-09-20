import type { Command } from "commander";
import { handleHostHook } from "../../hosts/hooks.js";
import {
  handoffOrchestrator,
  readOrchestratorLeaseCredentialsFromEnvironment,
  readOrchestratorStatus,
  recoverOrchestratorLease,
  selectOrchestrator,
  type OrchestratorHost,
} from "../../orchestration/selection.js";

export function orchestratorHost(value: string): OrchestratorHost {
  if (value !== "claude" && value !== "codex")
    throw new Error("Choose an orchestration host: claude or codex.");
  return value;
}

function checkpointKind(
  value: string,
): "before-work" | "completed-stage" | "paused" | "checkpointed" {
  if (
    value !== "before-work" &&
    value !== "completed-stage" &&
    value !== "paused" &&
    value !== "checkpointed"
  ) {
    throw new Error(
      "Unknown checkpoint kind. Use before-work, completed-stage, paused, or checkpointed.",
    );
  }
  return value;
}

/** Host selection is independent of workflow provider/model bindings. */
export function registerOrchestratorCommands(program: Command): void {
  const command = program
    .command("orchestrator")
    .description("Select the repository OMC lead host without reinstalling");
  command
    .command("hook")
    .description("Translate a native lifecycle payload for the shared OMC core")
    .requiredOption("--host <host>", "Native hook owner: claude or codex")
    .action(async (options: { host: string }) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 64 * 1024)
          throw new Error("orchestrator_hook_payload_too_large");
        chunks.push(bytes);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("orchestrator_hook_payload_invalid");
      }
      console.log(
        JSON.stringify(
          await handleHostHook(
            process.cwd(),
            orchestratorHost(options.host),
            payload,
          ),
        ),
      );
    });
  command
    .command("status")
    .description(
      "Report active host, supported hosts, CLI availability and handoff state",
    )
    .option("--json", "Output JSON (also the default)")
    .action(() => {
      console.log(
        JSON.stringify(readOrchestratorStatus(process.cwd()), null, 2),
      );
    });
  command
    .command("use <host>")
    .description("Select claude or codex at a quiescent workflow boundary")
    .action(async (host: string) => {
      console.log(
        JSON.stringify(
          await selectOrchestrator(process.cwd(), orchestratorHost(host)),
          null,
          2,
        ),
      );
    });
  command
    .command("recover")
    .description(
      "Recover an abandoned host lease only after all recorded processes have exited",
    )
    .requiredOption(
      "--checkpoint <kind>",
      "before-work, completed-stage, paused, or checkpointed",
    )
    .option("--workflow <name>", "Workflow checkpoint to retain")
    .option("--reference <reference>", "Recovery evidence reference")
    .action(
      async (options: {
        checkpoint: string;
        workflow?: string;
        reference?: string;
      }) => {
        await recoverOrchestratorLease(process.cwd(), {
          kind: checkpointKind(options.checkpoint),
          ...(options.workflow ? { workflowName: options.workflow } : {}),
          ...(options.reference ? { reference: options.reference } : {}),
        });
        console.log(
          JSON.stringify(readOrchestratorStatus(process.cwd()), null, 2),
        );
      },
    );
  command
    .command("handoff <host>")
    .description(
      "Checkpoint and revoke this host session before selecting another host",
    )
    .requiredOption(
      "--checkpoint <kind>",
      "before-work, completed-stage, paused, or checkpointed",
    )
    .option(
      "--workflow <name>",
      "Workflow whose shared checkpoint is being handed off",
    )
    .option("--reference <reference>", "Checkpoint evidence reference")
    .action(
      async (
        host: string,
        options: { checkpoint: string; workflow?: string; reference?: string },
      ) => {
        const credentials = readOrchestratorLeaseCredentialsFromEnvironment();
        if (!credentials)
          throw new Error(
            "Run handoff from the active OMC host session, or exit that session before using orchestrator use.",
          );
        const kind = checkpointKind(options.checkpoint);
        console.log(
          JSON.stringify(
            await handoffOrchestrator(process.cwd(), orchestratorHost(host), {
              credentials,
              checkpoint: {
                kind,
                ...(options.workflow ? { workflowName: options.workflow } : {}),
                ...(options.reference ? { reference: options.reference } : {}),
              },
            }),
            null,
            2,
          ),
        );
      },
    );
}

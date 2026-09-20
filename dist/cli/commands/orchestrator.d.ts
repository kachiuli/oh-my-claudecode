import type { Command } from "commander";
import { type OrchestratorHost } from "../../orchestration/selection.js";
export declare function orchestratorHost(value: string): OrchestratorHost;
/** Host selection is independent of workflow provider/model bindings. */
export declare function registerOrchestratorCommands(program: Command): void;
//# sourceMappingURL=orchestrator.d.ts.map
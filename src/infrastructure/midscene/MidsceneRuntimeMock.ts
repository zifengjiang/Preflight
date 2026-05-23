import type { MidsceneRuntime, MidsceneExecutionResult } from "../../domain/runtime/interfaces.js";
import type { TaskSpec } from "../../domain/task/TaskSpec.js";
import { ArtifactType } from "../../shared-kernel/enums/index.js";
import type { ResourceId } from "../../shared-kernel/ids/index.js";

export class MidsceneRuntimeMock implements MidsceneRuntime {
  async execute(task: TaskSpec, resourceId: ResourceId, signal?: AbortSignal): Promise<MidsceneExecutionResult> {
    if (signal?.aborted) {
      return {
        ok: false,
        message: "cancelled by platform",
        artifacts: [],
      };
    }
    const ok = task.script.trim().length > 0;
    return {
      ok,
      message: ok ? "mock execution success" : "script is empty",
      artifacts: [
        { type: ArtifactType.LOG, uri: `mock://artifact/${resourceId}/log.txt` },
        { type: ArtifactType.TRACE, uri: `mock://artifact/${resourceId}/trace.json` },
        { type: ArtifactType.SCREENSHOT, uri: `mock://artifact/${resourceId}/screen.png` },
      ],
    };
  }
}

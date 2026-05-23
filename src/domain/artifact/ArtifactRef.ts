import type { ArtifactType } from "../../shared-kernel/enums/index.js";
import type { ArtifactId, TaskId } from "../../shared-kernel/ids/index.js";

export class ArtifactRef {
  constructor(
    public readonly id: ArtifactId,
    public readonly taskId: TaskId,
    public readonly type: ArtifactType,
    public readonly uri: string,
  ) {}
}

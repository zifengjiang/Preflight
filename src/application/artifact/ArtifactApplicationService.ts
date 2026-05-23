import { ArtifactRef } from "../../domain/artifact/ArtifactRef.js";
import type { ArtifactRepository } from "../../domain/repositories/index.js";
import { asArtifactId, asTaskId, type TaskId } from "../../shared-kernel/ids/index.js";
import type { ArtifactType } from "../../shared-kernel/enums/index.js";

export class ArtifactApplicationService {
  constructor(private readonly artifactRepository: ArtifactRepository) {}

  async saveTaskArtifacts(
    taskId: TaskId,
    artifacts: Array<{ type: ArtifactType; uri: string }>,
  ): Promise<ArtifactRef[]> {
    const refs = artifacts.map(
      (item, index) =>
        new ArtifactRef(asArtifactId(`${taskId}-${index + 1}`), asTaskId(taskId), item.type, item.uri),
    );
    await this.artifactRepository.saveMany(refs);
    return refs;
  }
}

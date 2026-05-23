import type { ArtifactRef } from "./ArtifactRef.js";

export class ArtifactPipeline {
  constructor(public readonly artifacts: ArtifactRef[]) {}
}

import type { PlatformType } from "../../shared-kernel/enums/index.js";

export type TaskScriptKind = "midscene" | "airtest";

export interface AirtestTaskBundleSpec {
  bundleBase64: string;
  entryDir: string;
  archiveName?: string;
  caseRunId?: string;
  caseIndex?: number;
  caseName?: string;
}

export class TaskSpec {
  constructor(
    public readonly requiredPlatform: PlatformType,
    public readonly script: string,
    public readonly scriptKind: TaskScriptKind = "midscene",
    public readonly airtest?: AirtestTaskBundleSpec,
  ) {}
}

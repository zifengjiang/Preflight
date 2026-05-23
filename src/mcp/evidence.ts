import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceRun } from "./types.js";

export interface WriteEvidenceInput {
  run: EvidenceRun;
  outputRoot?: string;
}

export interface WriteEvidenceResult {
  runDir: string;
  evidencePath: string;
  metadataPath: string;
}

export async function writeEvidence(input: WriteEvidenceInput): Promise<WriteEvidenceResult> {
  const runDir = join(input.outputRoot ?? join(homedir(), ".preflight"), "self-test-runs", input.run.runId);
  await mkdir(runDir, { recursive: true });
  const evidencePath = join(runDir, "evidence.md");
  const metadataPath = join(runDir, "metadata.json");

  await writeFile(evidencePath, renderEvidenceMarkdown(input.run), "utf8");
  await writeFile(metadataPath, JSON.stringify(input.run, null, 2), "utf8");

  return { runDir, evidencePath, metadataPath };
}

function renderEvidenceMarkdown(run: EvidenceRun): string {
  const artifactLines = run.artifacts.length
    ? run.artifacts.map((artifact) => `- ${artifact.type}: ${artifact.uri}`).join("\n")
    : "- 暂无产物";
  return `# 自测留痕

- 结果：${run.status}
- 时间：${run.createdAt} -> ${run.updatedAt}
- 平台：${run.platform ?? "unknown"}
- 设备：${run.resourceId ?? "auto"}
- App 包：${run.appRef ?? "未指定"}
- Task ID：${run.taskId}
- Run ID：${run.runId}
- Live Viewer：${run.liveUrl}

## 测试意图

${run.testIntent ?? "未填写"}

## 执行脚本

\`\`\`ts
${run.script ?? ""}
\`\`\`

## Visual Flow

\`\`\`json
${run.visualFlow ? JSON.stringify(run.visualFlow, null, 2) : "{}"}
\`\`\`

## 结果摘要

${run.failureAnalysis.summary}

## 失败原因

- 分类：${run.failureAnalysis.category}
- 建议：${run.failureAnalysis.recommendation}

## 产物

${artifactLines}
`;
}

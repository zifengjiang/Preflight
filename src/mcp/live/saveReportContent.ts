import { pathToFileURL } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type Content = CallToolResult["content"][number];

export function buildSaveReportContent(input: {
  summaryText: string;
  evidencePath: string;
  cardPngBase64?: string;
}): Content[] {
  const out: Content[] = [{ type: "text", text: input.summaryText }];
  if (input.cardPngBase64) out.push({ type: "image", data: input.cardPngBase64, mimeType: "image/png" });
  const uri = input.evidencePath.startsWith("file://") ? input.evidencePath : pathToFileURL(input.evidencePath).href;
  out.push({ type: "resource_link", uri, mimeType: "text/html", name: "evidence.html" });
  return out;
}

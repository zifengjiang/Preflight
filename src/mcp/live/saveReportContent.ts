export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; mimeType?: string; name: string };

export function buildSaveReportContent(input: {
  summaryText: string;
  evidencePath: string;
  cardPngBase64?: string;
}): Content[] {
  const out: Content[] = [{ type: "text", text: input.summaryText }];
  if (input.cardPngBase64) out.push({ type: "image", data: input.cardPngBase64, mimeType: "image/png" });
  const uri = input.evidencePath.startsWith("file://") ? input.evidencePath : `file://${input.evidencePath}`;
  out.push({ type: "resource_link", uri, mimeType: "text/html", name: "evidence.html" });
  return out;
}

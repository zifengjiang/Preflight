import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarmonyDevice, getConnectedDevices } from "@midscene/harmony";
import {
  hdcListTargetsSimpleLines,
  hdcListTargetsVerboseStdout,
  looksLikeHdcTcpConnectKey,
  pickHarmonyDeviceIdFromList,
  resolveHarmonyDeviceIdFromVerboseList,
  resolveHdcCliExecutable,
} from "./harmonyHdcDeviceId.ts";

/** 与 midscene-device-session 一致：远程 hdc 时 Midscene 执行该脚本以注入 `hdc -s host:port`。 */
export function getHarmonyHdcBridgeScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "hdc-bridge.sh");
}

export function extractHarmonyDeviceIdFromResourceId(resourceId: string): string {
  const raw = String(resourceId).trim();
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1).trim() : raw;
}

export interface ConnectHarmonyAgentDebugDeviceParams {
  resourceId: string;
  harmonyHdcPath?: string;
  harmonyHdcHost?: string;
  harmonyHdcPort?: number;
}

/**
 * 创建并 connect 与任务执行（createHarmonySession）一致的 HarmonyDevice，供实时看屏 / 点击。
 */
export async function connectHarmonyAgentDebugDevice(params: ConnectHarmonyAgentDebugDeviceParams): Promise<HarmonyDevice> {
  const hdcPath = params.harmonyHdcPath?.trim();
  let deviceId = extractHarmonyDeviceIdFromResourceId(params.resourceId);

  const hasRemoteTconn =
    typeof params.harmonyHdcHost === "string" &&
    params.harmonyHdcHost.trim() &&
    typeof params.harmonyHdcPort === "number" &&
    Number.isFinite(params.harmonyHdcPort) &&
    params.harmonyHdcPort > 0;

  if (hasRemoteTconn) {
    const host = params.harmonyHdcHost!.trim();
    const port = params.harmonyHdcPort!;
    const server = { host, port };
    const hdcBin = resolveHdcCliExecutable(hdcPath);

    const remoteLines = await hdcListTargetsSimpleLines(hdcBin, 20_000, server);
    let resolved = pickHarmonyDeviceIdFromList(remoteLines, deviceId || undefined);
    if (!resolved) {
      const verbose = await hdcListTargetsVerboseStdout(hdcBin, 20_000, server);
      resolved = resolveHarmonyDeviceIdFromVerboseList(verbose, host, port, deviceId || undefined);
    }
    if (!resolved) {
      throw new Error(
        `鸿蒙实时看屏：hdc -s ${host}:${port} list targets 未解析到设备序列号。请核对 hdc 与 MIDSCENE_HARMONY_HDC_HOST/PORT，并在设备管理选择 harmony: 序列号。`,
      );
    }
    deviceId = resolved;

    process.env.HDC_S = `${host}:${port}`;
    process.env.HDC_REAL = hdcBin;
  } else if (!deviceId) {
    const devices = await getConnectedDevices(hdcPath);
    if (!devices.length) {
      throw new Error("鸿蒙实时看屏：没有可用鸿蒙设备（hdc list targets 为空）");
    }
    deviceId = devices[0].deviceId;
  }

  if (deviceId && looksLikeHdcTcpConnectKey(deviceId)) {
    throw new Error(
      "鸿蒙设备 ID 不能为 ip:port 连接串；请在设备管理选择序列号，或配置 MIDSCENE_HARMONY_HDC_HOST 与 MIDSCENE_HARMONY_HDC_PORT。",
    );
  }

  const realHdc = resolveHdcCliExecutable(hdcPath);
  const hdcPathForMidscene = hasRemoteTconn ? getHarmonyHdcBridgeScriptPath() : hdcPath ? realHdc : undefined;

  const device = new HarmonyDevice(deviceId, {
    ...(hdcPathForMidscene ? { hdcPath: hdcPathForMidscene } : {}),
  });
  await device.connect();
  return device;
}

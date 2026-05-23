/**
 * 设备探测得到的展示用信息（字段均为尽力而为，缺失时不填）。
 */
export interface DeviceDetails {
  manufacturer?: string;
  /** ro.product.brand */
  brand?: string;
  /** 用户在系统设置中的本机名称（如 iOS「关于本机」名称、Android 设备名称） */
  deviceName?: string;
  model?: string;
  /** ro.product.device 设备代号 */
  deviceCodename?: string;
  osName?: string;
  osVersion?: string;
  /** ro.build.fingerprint */
  buildFingerprint?: string;
  /** 已知时为 0–100；未知为 null */
  batteryPercent?: number | null;
}

export function compactDeviceDetails(details: DeviceDetails): DeviceDetails | undefined {
  const out: DeviceDetails = {};
  if (details.manufacturer?.trim()) out.manufacturer = details.manufacturer.trim();
  if (details.brand?.trim()) out.brand = details.brand.trim();
  if (details.deviceName?.trim()) out.deviceName = details.deviceName.trim();
  if (details.model?.trim()) out.model = details.model.trim();
  if (details.deviceCodename?.trim()) out.deviceCodename = details.deviceCodename.trim();
  if (details.osName?.trim()) out.osName = details.osName.trim();
  if (details.osVersion?.trim()) out.osVersion = details.osVersion.trim();
  if (details.buildFingerprint?.trim()) out.buildFingerprint = details.buildFingerprint.trim();
  if (details.batteryPercent != null && Number.isFinite(details.batteryPercent)) {
    out.batteryPercent = Math.max(0, Math.min(100, Math.round(details.batteryPercent)));
  }
  return Object.keys(out).length ? out : undefined;
}

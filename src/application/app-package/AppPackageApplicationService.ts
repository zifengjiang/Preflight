import type { LeaseApplicationService } from "../lease/LeaseApplicationService.js";
import type { ResourceRepository } from "../../domain/repositories/index.js";
import { LeaseRequiredError } from "../../shared-kernel/errors/index.js";
import { OwnerType, PlatformType, ResourceStatus } from "../../shared-kernel/enums/index.js";
import { asResourceId, type ResourceId } from "../../shared-kernel/ids/index.js";
import { parseDeviceTargetFromResourceId } from "../../utils/deviceResourceRouting.js";
import { AppPackageUrlCache } from "../../infrastructure/app-package/AppPackageUrlCache.js";
import { resolveAppRefToLocalFile } from "../../utils/appPackageLocalPath.js";
import { DeviceAppPackageOps } from "../../infrastructure/device/DeviceAppPackageOps.js";

const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
const DEFAULT_UNINSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_AUTO_LEASE_TTL_SECONDS = 300;

export type AppPackageServiceOptions = {
  downloadDir?: string;
  installTimeoutMs?: number;
  uninstallTimeoutMs?: number;
  /** 无租约时自动占用设备（与任务调度类似的体验） */
  autoLeaseTtlSeconds?: number;
  urlCache?: AppPackageUrlCache;
};

/**
 * 三端安装/卸载：Android `adb`、iOS `ideviceinstaller`、鸿蒙 `hdc`。
 * 需资源在线；无活跃租约时可按配置自动 acquire。
 */
export class AppPackageApplicationService {
  constructor(
    private readonly leaseService: LeaseApplicationService,
    private readonly resourceRepository: ResourceRepository,
    private readonly ops: DeviceAppPackageOps,
    private readonly options: AppPackageServiceOptions = {},
  ) {}

  private installTimeout(): number {
    const n = this.options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INSTALL_TIMEOUT_MS;
  }

  private uninstallTimeout(): number {
    const n = this.options.uninstallTimeoutMs ?? DEFAULT_UNINSTALL_TIMEOUT_MS;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UNINSTALL_TIMEOUT_MS;
  }

  private autoLeaseTtl(): number {
    const n = this.options.autoLeaseTtlSeconds ?? DEFAULT_AUTO_LEASE_TTL_SECONDS;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AUTO_LEASE_TTL_SECONDS;
  }

  private async ensureLease(resourceId: ResourceId): Promise<void> {
    try {
      await this.leaseService.ensureActive(resourceId);
    } catch (error: unknown) {
      if (!(error instanceof LeaseRequiredError)) throw error;
      const leaseId = `lease-app-install-${Date.now()}`;
      await this.leaseService.acquire(
        leaseId,
        String(resourceId),
        `app-package-${Date.now()}`,
        OwnerType.PLATFORM_TASK,
        this.autoLeaseTtl(),
      );
    }
  }

  async install(resourceId: string, appRef: string): Promise<void> {
    const rid = asResourceId(resourceId);
    await this.ensureLease(rid);

    const parsed = parseDeviceTargetFromResourceId(resourceId);
    if (!parsed) {
      throw new Error(`invalid resourceId (expect android:|ios:|harmony: prefix): ${resourceId}`);
    }

    const device = await this.resourceRepository.getById(rid);
    if (!device || device.status !== ResourceStatus.ONLINE) {
      throw new Error(`resource not online: ${resourceId}`);
    }
    if (device.platform !== parsed.platform) {
      throw new Error(`resource platform mismatch for ${resourceId}`);
    }

    const resolved =
      this.options.urlCache && AppPackageUrlCache.isHttpRef(appRef)
        ? await this.options.urlCache.resolveHttpToLocalPackage(appRef, device.platform)
        : await resolveAppRefToLocalFile(appRef, device.platform, this.options.downloadDir);
    try {
      const paths =
        parsed.platform === PlatformType.ANDROID ? { serial: parsed.serial }
        : parsed.platform === PlatformType.IOS ? { udid: parsed.udid }
        : { deviceId: parsed.deviceId };

      await this.ops.install(parsed.platform, paths, resolved.localPath, this.installTimeout());
    } finally {
      await resolved.cleanupTemp();
    }
  }

  async uninstall(resourceId: string, bundleId: string): Promise<void> {
    const rid = asResourceId(resourceId);
    const id = bundleId.trim();
    if (!id) throw new Error("bundleId is empty");

    await this.ensureLease(rid);

    const parsed = parseDeviceTargetFromResourceId(resourceId);
    if (!parsed) {
      throw new Error(`invalid resourceId (expect android:|ios:|harmony: prefix): ${resourceId}`);
    }

    const device = await this.resourceRepository.getById(rid);
    if (!device || device.status !== ResourceStatus.ONLINE) {
      throw new Error(`resource not online: ${resourceId}`);
    }
    if (device.platform !== parsed.platform) {
      throw new Error(`resource platform mismatch for ${resourceId}`);
    }

    const paths =
      parsed.platform === PlatformType.ANDROID ? { serial: parsed.serial }
      : parsed.platform === PlatformType.IOS ? { udid: parsed.udid }
      : { deviceId: parsed.deviceId };

    await this.ops.uninstall(parsed.platform, paths, id, this.uninstallTimeout());
  }
}

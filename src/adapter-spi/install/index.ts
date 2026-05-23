/** 设备应用安装/卸载（Android adb / iOS ideviceinstaller / 鸿蒙 hdc） */
export interface DeviceAppPackageOperations {
  install(resourceId: string, appRef: string): Promise<void>;
  uninstall(resourceId: string, bundleId: string): Promise<void>;
}

/** @deprecated 使用 DeviceAppPackageOperations */
export type InstallController = Pick<DeviceAppPackageOperations, "install">;

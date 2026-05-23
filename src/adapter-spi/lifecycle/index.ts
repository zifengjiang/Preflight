export interface AppLifecycleController {
  startApp(resourceId: string, appRef: string): Promise<void>;
  stopApp(resourceId: string, appRef: string): Promise<void>;
}

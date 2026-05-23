import { installAppOnAgent, uninstallAppOnAgent } from "../../client/agentAppPackageClient.js";

/**
 * Task-side app install/uninstall API (via Agent HTTP `POST /platform/commands`, synchronous wait).
 * Requires `AGENT_RESOURCE_ID` env var (injected by TaskApplicationService when running as a task).
 */
export type TaskAppPackageApi = {
  installApp: (appRef: string) => Promise<void>;
  uninstallApp: (bundleId: string) => Promise<void>;
};

function requireTaskResourceId(): string {
  const id = process.env.AGENT_RESOURCE_ID?.trim();
  if (!id) {
    throw new Error(
      "installApp / uninstallApp requires AGENT_RESOURCE_ID (injected by Agent when dispatching a task — do not call from bare scripts)",
    );
  }
  return id;
}

export function createTaskAppPackageFromEnv(): TaskAppPackageApi {
  return {
    installApp: async (appRef: string): Promise<void> => {
      const resourceId = requireTaskResourceId();
      await installAppOnAgent({ resourceId, appRef });
    },
    uninstallApp: async (bundleId: string): Promise<void> => {
      const resourceId = requireTaskResourceId();
      await uninstallAppOnAgent({ resourceId, bundleId });
    },
  };
}

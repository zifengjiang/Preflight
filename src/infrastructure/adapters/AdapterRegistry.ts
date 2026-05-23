import type { ResourceAdapter } from "../../adapter-spi/resource/index.js";
import type { CommandExecutor } from "../../adapter-spi/command/index.js";
import type { SnapshotProvider } from "../../adapter-spi/snapshot/index.js";

export class AdapterRegistry {
  constructor(
    public readonly resourceAdapters: ResourceAdapter[],
    public readonly commandExecutor: CommandExecutor,
    public readonly snapshotProvider: SnapshotProvider,
  ) {}
}

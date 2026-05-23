import type { AdapterRegistry } from "./AdapterRegistry.js";

export class BridgeAdapters {
  constructor(public readonly registry: AdapterRegistry) {}
}

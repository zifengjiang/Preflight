export interface SnapshotProvider {
  snapshot(resourceId: string): Promise<{ uri: string }>;
}

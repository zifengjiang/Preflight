export interface ArtifactProvider {
  collect(taskId: string): Promise<Array<{ type: string; uri: string }>>;
}

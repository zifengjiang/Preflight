export interface CommandExecutor {
  execute(resourceId: string, command: string): Promise<{ output: string }>;
}

import type { CommandExecutor } from "../../../adapter-spi/command/index.js";
import type { SnapshotProvider } from "../../../adapter-spi/snapshot/index.js";
import type { CommandRunner } from "../../system/CommandRunner.js";

function renderTemplate(template: string, resourceId: string, command?: string): string {
  return template
    .replaceAll("{resourceId}", resourceId)
    .replaceAll("{command}", command ?? "");
}

export class ShellCommandExecutor implements CommandExecutor {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly commandTemplate: string,
  ) {}

  async execute(resourceId: string, command: string): Promise<{ output: string }> {
    const shellCommand = renderTemplate(this.commandTemplate, resourceId, command);
    const result = await this.commandRunner.run(shellCommand, 30_000);
    if (!result.ok) {
      throw new Error(`debug command failed: ${result.stderr || result.stdout}`);
    }
    return { output: result.stdout.trim() || "ok" };
  }
}

export class ShellSnapshotProvider implements SnapshotProvider {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly snapshotTemplate: string,
  ) {}

  async snapshot(resourceId: string): Promise<{ uri: string }> {
    const shellCommand = renderTemplate(this.snapshotTemplate, resourceId);
    const result = await this.commandRunner.run(shellCommand, 30_000);
    if (!result.ok) {
      throw new Error(`snapshot failed: ${result.stderr || result.stdout}`);
    }
    const uri = result.stdout.trim();
    if (!uri) {
      throw new Error("snapshot command returned empty uri");
    }
    return { uri };
  }
}

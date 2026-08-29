import type { BackgroundCoordinator } from "./coordinator";

export const COMMANDS = [
  "toggle-visibility",
  "nudge-left",
  "nudge-right",
  "nudge-up",
  "nudge-down",
] as const;

export type PixelPincherCommand = (typeof COMMANDS)[number];

export function isPixelPincherCommand(value: string): value is PixelPincherCommand {
  return COMMANDS.some((command) => command === value);
}

/** Keeps Chrome's untrusted command names at the entrypoint boundary. */
export async function handleCommand(
  coordinator: BackgroundCoordinator,
  command: PixelPincherCommand,
): Promise<void> {
  await coordinator.handleCommand(command);
}

import type { BackgroundCoordinator } from "./coordinator";

export type TopFrameNavigation = Readonly<{
  tabId: number;
  frameId: number;
  url: string;
}>;

/** Handles only trusted top-frame webNavigation events. */
export async function handleTopFrameNavigation(
  coordinator: BackgroundCoordinator,
  navigation: TopFrameNavigation,
): Promise<void> {
  if (navigation.frameId !== 0) return;
  await coordinator.handleNavigation(navigation);
}

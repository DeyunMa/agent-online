export type ProjectExclusiveActivity = "idle" | "preview_starting" | "run" | "terminal";
export type ProjectPreviewState = "running" | "starting" | "stopped";

export type ProjectActivity = {
  exclusive: ProjectExclusiveActivity;
  preview: ProjectPreviewState;
};

export function deriveProjectActivity(input: {
  previewActive: boolean;
  previewStarting: boolean;
  runActive: boolean;
  terminalActive: boolean;
}): ProjectActivity {
  const preview = input.previewStarting ? "starting" : input.previewActive ? "running" : "stopped";

  if (input.runActive) {
    return { exclusive: "run", preview };
  }
  if (input.terminalActive) {
    return { exclusive: "terminal", preview };
  }
  if (input.previewStarting) {
    return { exclusive: "preview_starting", preview };
  }
  return { exclusive: "idle", preview };
}

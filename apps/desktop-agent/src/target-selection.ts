import type { ClientTarget } from "@easycode/protocol";

export type TargetSelectionOptions = {
  targetId?: string;
  targetIndex?: number;
  targetTitle?: string;
};

export const selectTarget = (targets: ClientTarget[], options: TargetSelectionOptions): ClientTarget => {
  if (targets.length === 0) throw new Error("No targets discovered");

  if (options.targetId) {
    const target = targets.find((candidate) => candidate.id === options.targetId);
    if (!target) throw new Error(`No target matched id "${options.targetId}"`);
    return target;
  }

  if (typeof options.targetIndex === "number") {
    const target = targets[options.targetIndex];
    if (!target) throw new Error(`No target at zero-based index ${options.targetIndex}`);
    return target;
  }

  if (options.targetTitle) {
    const normalized = options.targetTitle.toLowerCase();
    const target = targets.find((candidate) => candidate.title.toLowerCase().includes(normalized));
    if (!target) throw new Error(`No target title contained "${options.targetTitle}"`);
    return target;
  }

  const target = targets[0];
  if (!target) throw new Error("No target selected");
  return target;
};

export const formatTargets = (targets: ClientTarget[]): string =>
  targets
    .map((target, index) => `${index}: ${target.title} [${target.id}] (${target.appName})`)
    .join("\n");

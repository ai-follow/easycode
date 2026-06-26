import type { InteractionRequest } from "@easycode/protocol";

export type PrimaryInteractionAction = {
  request: InteractionRequest;
  option: InteractionRequest["options"][number];
};

export type MobileQuickAction =
  | ({
    type: "interaction";
    label: string;
  } & PrimaryInteractionAction)
  | {
    type: "continue_text";
    label: "Continue";
    text: typeof DEFAULT_CONTINUE_TEXT;
  };

export const DEFAULT_CONTINUE_TEXT = "continue";

const primaryActionPatterns = [
  /\b(continue|proceed|resume|retry)\b/i,
  /\b(approve|allow|accept|yes|ok|okay|run)\b/i
] as const;

export const selectPrimaryInteractionAction = (
  interactions: InteractionRequest[]
): PrimaryInteractionAction | undefined => {
  let best:
    | (PrimaryInteractionAction & {
      patternIndex: number;
      requestIndex: number;
      optionIndex: number;
    })
    | undefined;

  interactions.forEach((request, requestIndex) => {
    request.options.forEach((option, optionIndex) => {
      const patternIndex = primaryActionPatterns.findIndex((pattern) => pattern.test(option.label));
      if (patternIndex < 0) return;

      if (
        !best ||
        patternIndex < best.patternIndex ||
        (patternIndex === best.patternIndex && requestIndex < best.requestIndex) ||
        (patternIndex === best.patternIndex && requestIndex === best.requestIndex && optionIndex < best.optionIndex)
      ) {
        best = {
          request,
          option,
          patternIndex,
          requestIndex,
          optionIndex
        };
      }
    });
  });

  return best ? { request: best.request, option: best.option } : undefined;
};

export const selectMobileQuickAction = (
  interactions: InteractionRequest[],
  hasActiveSession: boolean
): MobileQuickAction | undefined => {
  const interaction = selectPrimaryInteractionAction(interactions);
  if (interaction) {
    return {
      type: "interaction",
      label: interaction.option.label,
      request: interaction.request,
      option: interaction.option
    };
  }

  if (hasActiveSession && interactions.length === 0) {
    return {
      type: "continue_text",
      label: "Continue",
      text: DEFAULT_CONTINUE_TEXT
    };
  }

  return undefined;
};

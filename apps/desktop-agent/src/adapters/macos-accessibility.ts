import { createHash } from "node:crypto";
import type {
  ClientAdapterId,
  ClientMessage,
  ConversationSnapshot,
  InteractionRequest,
  SessionState
} from "@easycode/protocol";
import { nowIso } from "@easycode/protocol";

export type AccessibilityElement = {
  role: string;
  roleDescription: string;
  name: string;
  value: string;
  description: string;
  enabled: boolean;
};

export type AccessibilitySnapshotInput = {
  adapterId: ClientAdapterId;
  sessionId: string;
  title: string;
  elements: AccessibilityElement[];
  capturedAt?: string;
  stateDetail?: string;
};

const INTERACTION_LABEL_PATTERN =
  /\b(approve|allow|accept|yes|ok|okay|continue|proceed|resume|run|retry|reject|deny|decline|no|cancel|stop)\b/i;

const IGNORE_TEXT = new Set([
  "accounts",
  "activity bar",
  "debug",
  "extensions",
  "explorer",
  "files",
  "manage",
  "notifications",
  "problems",
  "remote explorer",
  "run and debug",
  "search",
  "settings",
  "source control",
  "terminal"
]);

export const parseAccessibilityDump = (raw: string): AccessibilityElement[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const fields = splitEscapedFields(line);
      return {
        role: fields[0] ?? "",
        roleDescription: fields[1] ?? "",
        name: fields[2] ?? "",
        value: fields[3] ?? "",
        description: fields[4] ?? "",
        enabled: (fields[5] ?? "").toLowerCase() === "true"
      };
    });

export const buildConversationSnapshotFromAccessibility = ({
  adapterId,
  sessionId,
  title,
  elements,
  capturedAt = nowIso(),
  stateDetail = "Captured from macOS accessibility tree"
}: AccessibilitySnapshotInput): ConversationSnapshot => {
  const messages = extractMessages(adapterId, sessionId, elements, capturedAt);
  const pendingInteractions = extractInteractionRequests(adapterId, sessionId, elements, messages);

  const state: SessionState = {
    status: pendingInteractions.length > 0 ? "waiting_for_user" : "idle",
    title,
    detail: stateDetail,
    updatedAt: capturedAt
  };

  return {
    sessionId,
    adapterId,
    title,
    messages,
    pendingInteractions,
    state,
    capturedAt
  };
};

export const extractMessages = (
  adapterId: ClientAdapterId,
  sessionId: string,
  elements: AccessibilityElement[],
  capturedAt: string
): ClientMessage[] => {
  const candidates = elements
    .flatMap(textCandidates)
    .map(normalizeText)
    .filter(isUsefulConversationText);

  const seenTexts = new Set<string>();
  const messages: ClientMessage[] = [];

  for (const text of candidates) {
    const normalizedKey = text.toLowerCase();
    if (seenTexts.has(normalizedKey)) continue;
    seenTexts.add(normalizedKey);

    const inferred = inferRole(text);
    messages.push({
      id: `message_${fingerprint([adapterId, sessionId, inferred.text])}`,
      role: inferred.role,
      text: inferred.text,
      createdAt: capturedAt,
      raw: {
        source: "macos-accessibility"
      }
    });
  }

  return messages.slice(-80);
};

export const extractInteractionRequests = (
  adapterId: ClientAdapterId,
  sessionId: string,
  elements: AccessibilityElement[],
  messages: ClientMessage[]
): InteractionRequest[] => {
  const options = elements
    .filter((element) => isButtonElement(element) && element.enabled)
    .map((element) => normalizeText(element.name || element.value || element.description))
    .filter(isUsefulInteractionLabel)
    .filter((label, index, labels) => labels.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) === index)
    .map((label) => ({
      id: `option_${fingerprint([label])}`,
      label,
      value: label
    }));

  if (options.length === 0) return [];

  const context = messages.at(-1)?.text ?? "Client interaction request";
  return [
    {
      id: `interaction_${fingerprint([adapterId, sessionId, context, ...options.map((option) => option.label)])}`,
      text: context,
      options,
      raw: {
        source: "macos-accessibility",
        optionLabels: options.map((option) => option.label)
      }
    }
  ];
};

export const fingerprint = (parts: string[]): string =>
  createHash("sha256")
    .update(parts.join("\u001f"))
    .digest("hex")
    .slice(0, 16);

const textCandidates = (element: AccessibilityElement): string[] => {
  const roleText = `${element.role} ${element.roleDescription}`.toLowerCase();
  if (isButtonElement(element)) return [];

  if (roleText.includes("text") || roleText.includes("group") || roleText.includes("row")) {
    return [element.value, element.name, element.description].filter(Boolean);
  }

  return [element.value, element.name].filter(Boolean);
};

const isButtonElement = (element: AccessibilityElement): boolean => {
  const roleText = `${element.role} ${element.roleDescription}`.toLowerCase();
  return roleText.includes("button");
};

const isUsefulConversationText = (text: string): boolean => {
  if (text.length < 2) return false;
  if (text.length > 6000) return false;
  if (IGNORE_TEXT.has(text.toLowerCase())) return false;
  if (/^[\W_]+$/.test(text)) return false;
  return true;
};

const isUsefulInteractionLabel = (label: string): boolean => {
  if (label.length < 2) return false;
  if (label.length > 120) return false;
  if (IGNORE_TEXT.has(label.toLowerCase())) return false;
  return INTERACTION_LABEL_PATTERN.test(label);
};

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const inferRole = (text: string): Pick<ClientMessage, "role" | "text"> => {
  const match = text.match(/^(user|you|human|assistant|cursor|claude|codex)\s*:\s*(.+)$/i);
  if (!match) return { role: "client", text };

  const label = match[1]?.toLowerCase();
  const body = match[2]?.trim() || text;
  if (label === "user" || label === "you" || label === "human") return { role: "user", text: body };
  return { role: "assistant", text: body };
};

const splitEscapedFields = (line: string): string[] => line.split("\t").map(unescapeField);

const unescapeField = (value: string): string => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      output += char;
      continue;
    }

    const next = value[index + 1];
    if (next === "n") {
      output += "\n";
      index += 1;
    } else if (next === "t") {
      output += "\t";
      index += 1;
    } else if (next === "\\") {
      output += "\\";
      index += 1;
    } else {
      output += char;
    }
  }
  return output;
};

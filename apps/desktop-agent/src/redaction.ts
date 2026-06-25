const REDACTED = "[redacted]";
const REDACTED_EMAIL = "[redacted-email]";

const SENSITIVE_NAME_PATTERN =
  "(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret|session[_-]?token|token)";

const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `\\b([A-Z0-9_.-]*${SENSITIVE_NAME_PATTERN}[A-Z0-9_.-]*)(\\s*[:=]\\s*)(["']?)([^\\s"',;]+)(["']?)`,
  "gi"
);

export const redactSensitiveText = (value: string): string => {
  let redacted = value;

  redacted = redacted.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`
  );

  redacted = redacted.replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key, separator, openQuote, _secret, closeQuote) =>
    `${key}${separator}${openQuote}${REDACTED}${closeQuote}`
  );

  redacted = redacted.replace(/\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
  redacted = redacted.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED}`);

  redacted = redacted.replace(/\bsk-(?:proj-|ant-[A-Za-z0-9_-]*-)?[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  redacted = redacted.replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/g, REDACTED);
  redacted = redacted.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED);
  redacted = redacted.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED);

  redacted = redacted.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED_EMAIL);
  redacted = redacted.replace(/\/Users\/([^/\s"':]+)(?=\/)/g, `/Users/${REDACTED}`);
  redacted = redacted.replace(/\/home\/([^/\s"':]+)(?=\/)/g, `/home/${REDACTED}`);
  redacted = redacted.replace(/([A-Za-z]:\\Users\\)([^\\\s"':]+)(?=\\)/g, `$1${REDACTED}`);

  return redacted;
};

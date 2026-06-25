export const parseAllowedOrigins = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  return normalizeAllowedOrigins(value.split(","));
};

export const normalizeAllowedOrigins = (allowedOrigins: string[] | undefined): string[] =>
  (allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean);

export const isOriginAllowed = (origin: string | undefined, allowedOrigins: string[] | undefined): boolean => {
  const normalized = normalizeAllowedOrigins(allowedOrigins);
  if (normalized.length === 0 || normalized.includes("*")) return true;
  return Boolean(origin && normalized.includes(origin));
};

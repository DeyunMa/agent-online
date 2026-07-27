export const sensitivePatterns = [
  {
    label: "Google API key",
    pattern: /AIza[0-9A-Za-z_-]{30,}/,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/,
  },
  {
    label: "assigned application secret",
    pattern:
      /\b(?:ACCESS_ALLOWED_EMAILS|BETTER_AUTH_SECRET|E2B_API_KEY|GEMINI_API_KEY)\s*[:=]\s*["'][^"'\r\n]{8,}["']/,
  },
];

export function findSensitiveLabels(contents) {
  if (contents.includes(0)) {
    return [];
  }

  const text = contents.toString("utf8");
  return sensitivePatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

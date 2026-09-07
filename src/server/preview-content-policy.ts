// Preview documents must remain isolated even when opened outside the UI iframe.
export const previewContentCsp = [
  "sandbox allow-scripts",
  "default-src 'self' data: blob:",
  "base-uri 'self'",
  "connect-src 'none'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "worker-src blob:",
].join("; ");

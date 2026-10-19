const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^\s",]{8,}/gi
]

export function redact(s: string): string {
  let out = s
  for (const re of PATTERNS) out = out.replace(re, (_m, p1) => (typeof p1 === 'string' ? p1 : '') + '[REDACTED]')
  return out
}

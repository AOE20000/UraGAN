import type { Issue, IssueSeverity, ValidationReport } from '@uragan/shared';

/** 构造一条 issue */
export function issue(
  code: string,
  severity: IssueSeverity,
  path: string,
  message: string,
  hint?: string,
): Issue {
  return { code, severity, path, message, ...(hint ? { hint } : {}) };
}

/** 全绿报告 */
export function okReport(): ValidationReport {
  return { ok: true, level: 'warning', errors: [] };
}

/** 由 issues 汇总 report：存在任一 error 即 ok=false、level=error */
export function issuesReport(issues: Issue[]): ValidationReport {
  const hasError = issues.some((i) => i.severity === 'error');
  return { ok: !hasError, level: hasError ? 'error' : 'warning', errors: issues };
}
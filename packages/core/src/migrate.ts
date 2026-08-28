import type { ValidationReport } from '@uragan/shared';
import { SCHEMA_VERSION } from '@uragan/shared';
import { issue, issuesReport, okReport } from './report.js';

/**
 * schemaVersion 迁移器注册表（设计文档 §10 M6 / §11.4）：
 * 未来 schema 演进时 registerMigration({ from: '1', to: '2', migrate })，
 * 链式升级后统一为当前版本。当前起始版本为 '1'，注册表为空即合法。
 */

export interface Migration {
  from: string;
  to: string;
  /** 幂等：入参为 from 版本的数据，出参为 to 版本的数据 */
  migrate: (data: unknown) => unknown;
}

const registry = new Map<string, Migration>();

/** 注册迁移器：同 from 重复注册视为编程错误（抛错） */
export function registerMigration(m: Migration): void {
  if (registry.has(m.from)) throw new Error(`重复注册 schemaVersion 迁移：${m.from}`);
  registry.set(m.from, m);
}

export interface MigrateResult {
  data: unknown;
  /** 是否发生了迁移 */
  changed: boolean;
  report: ValidationReport;
}

/**
 * 链式迁移到当前版本：
 * - 无 schemaVersion / 已是当前版本 → 原样返回
 * - 存在可迁移路径 → 逐级 migrate，返回 changed=true
 * - 版本未知且无迁移器 → 返回 changed=false + U-1009 报错（调用方拒绝放行）
 */
export function migrateData(input: unknown): MigrateResult {
  if (!input || typeof input !== 'object' || !('schemaVersion' in (input as Record<string, unknown>))) {
    return { data: input, changed: false, report: okReport() };
  }
  let data: unknown = input;
  const visited = new Set<string>();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = String((data as Record<string, unknown>).schemaVersion);
    if (v === SCHEMA_VERSION) break;
    if (visited.has(v)) break; // 迁移环保护
    visited.add(v);
    const m = registry.get(v);
    if (!m) {
      return {
        data,
        changed: visited.size > 1,
        report: issuesReport([
          issue('U-1009', 'error', 'schemaVersion', `不支持的 schemaVersion：${v}（当前 ${SCHEMA_VERSION}）`, '需先升级配置文件或安装对应迁移器'),
        ]),
      };
    }
    data = m.migrate(data);
    (data as { schemaVersion?: unknown }).schemaVersion = m.to;
  }
  const changed = visited.size > 0;
  return { data, changed, report: okReport() };
}
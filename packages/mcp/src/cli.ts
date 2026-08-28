#!/usr/bin/env node
import { startServer } from './index.js';

startServer().catch((e: unknown) => {
  console.error(`uragan-mcp 启动失败：${(e as Error).message}`);
  process.exitCode = 1;
});
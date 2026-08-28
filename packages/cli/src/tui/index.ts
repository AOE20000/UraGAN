import React from 'react';
import { render } from 'ink';
import { TuiApp } from './app.js';

/** 在进程当前终端（原窗口）启动交互式 TUI；接管 stdout 直到用户按 q 退出。 */
export async function launchTui(projectPath: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('TUI 需要在真实的交互终端（TTY）中运行（如 Windows Terminal / PowerShell 窗口）。');
    console.error('命令示例：node packages/cli/dist/index.js tui -p project.uragan');
    return 1;
  }
  const { waitUntilExit } = render(React.createElement(TuiApp, { projectPath }));
  try {
    await waitUntilExit();
    return 0;
  } finally {
    process.stdout.write('\n');
  }
}
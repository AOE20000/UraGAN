// 便携产物 MCP 冒烟：initialize + tools/list（在独立临时目录运行）
import { spawn } from 'node:child_process';

const probe = (cli) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    }, 800);
    setTimeout(() => {
      const tools = (out
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .find((x) => x.id === 2)?.result?.tools) || [];
      console.log('serverInfo 含 uragan:', out.includes('"name":"uragan"'));
      console.log('工具数:', tools.length);
      console.log('工具名:', tools.map((t) => t.name).join(', '));
      p.kill();
      resolve(tools.length === 15);
    }, 4500);
  });

const ok = await probe(process.argv[2]);
process.exit(ok ? 0 : 1);
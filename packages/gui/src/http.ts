import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';

/**
 * 极简 HTTP 路由薄层（零依赖）：get/post + stream + json/query。
 * 供 @uragan/gui 使用（node:http 封装，无框架）。内联于 dist 之外的 src，不对外暴露。
 */

export interface ReqCtx {
  pathname: string;
  url: URL;
  query: URLSearchParams;
  json: () => Promise<unknown>;
}

export interface HttpResponse {
  status: number;
  /** 默认输出 JSON；type='html' 时按 HTML 文本输出 */
  body?: unknown;
  type?: 'html' | 'json';
  /** 静态文件流式输出（优先级高于 body） */
  file?: { path: string; mime: string };
}

export type Handler = ((req: ReqCtx) => HttpResponse | Promise<HttpResponse>) | (() => HttpResponse | Promise<HttpResponse>);

function send(res: ServerResponse, r: HttpResponse, req?: IncomingMessage): void {
  if (r.file) {
    const { path, mime } = r.file;
    if (!req || req.method === 'GET') {
      res.writeHead(r.status, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      createReadStream(path).pipe(res);
      return;
    }
  }
  const type = r.type === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(r.status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(r.type === 'html' && typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
}

export interface HttpServer {
  get: (path: string, handler: Handler) => void;
  post: (path: string, handler: Handler) => void;
  /** path 前缀匹配：handler 返回 { path, mime } 或 undefined（404） */
  stream: (prefix: string, handler: (req: ReqCtx) => { path: string; mime: string } | undefined) => void;
  /** 监听；port 传 0 时使用随机端口，返回实际端口与关闭函数 */
  listen: (port: number) => Promise<{ port: number; url: string; close: () => Promise<void> }>;
}

export function createHttp(): HttpServer {
  const routes = new Map<string, { method: string; handler: Handler }>();
  const streams: { prefix: string; handler: (req: ReqCtx) => { path: string; mime: string } | undefined }[] = [];

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const ctx: ReqCtx = {
      pathname: url.pathname,
      url,
      query: url.searchParams,
      json: () =>
        new Promise<unknown>((ok, reject) => {
          let data = '';
          req.on('data', (c: Buffer) => {
            data += c;
            if (data.length > 128 * 1024 * 1024) reject(new Error('请求体过大'));
          });
          req.on('end', () => {
            try {
              ok(data.length > 0 ? (JSON.parse(data) as unknown) : {});
            } catch {
              reject(new Error('请求体不是合法 JSON'));
            }
          });
          req.on('error', reject);
        }),
    };

    let handled = false;
    for (const [routePath, r] of routes) {
      if (r.method === req.method && routePath === `${req.method} ${ctx.pathname}`) {
        handled = true;
        try {
          send(res, await r.handler(ctx), req);
        } catch (e) {
          send(res, { status: 500, body: { ok: false, message: `服务器错误：${(e as Error).message}` } });
        }
        return;
      }
    }
    if (req.method === 'GET') {
      for (const s of streams) {
        if (ctx.pathname.startsWith(s.prefix)) {
          const found = s.handler(ctx);
          if (found) {
            handled = true;
            send(res, { status: 200, file: { path: found.path, mime: found.mime } });
            return;
          }
        }
      }
    }
    if (!handled) send(res, { status: 404, body: { ok: false, message: `未知路由：${req.method} ${ctx.pathname}` } });
  });

  return {
    get: (path, handler) => routes.set(`GET ${path}`, { method: 'GET', handler }),
    post: (path, handler) => routes.set(`POST ${path}`, { method: 'POST', handler }),
    stream: (prefix, handler) => streams.push({ prefix, handler }),
    listen: (port) =>
      new Promise((ok) => {
        server.listen(port === 0 ? undefined : port, '127.0.0.1', () => {
          const addr = server.address();
          const bound = typeof addr === 'object' && addr ? addr.port : port;
          ok({
            port: bound,
            url: `http://127.0.0.1:${bound}`,
            close: () => new Promise<void>((done) => server.close(() => done())),
          });
        });
      }),
  };
}
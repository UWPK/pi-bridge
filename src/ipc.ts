import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { BridgeError, ExitCode } from "./errors.js";

/**
 * Local IPC (需求文档 §3.2, §5).
 *
 * v1 = 127.0.0.1 HTTP with a random session token stored in a user-private file.
 * Binds loopback only; never 0.0.0.0. The token is required on every request so
 * another local process cannot drive the daemon by accident.
 */

export interface DaemonEndpoint {
  host: string;
  port: number;
  token: string;
}

export function writeEndpoint(files: { portFile: string; tokenFile: string }, endpoint: DaemonEndpoint): void {
  const dir = dirname(endpoint ? files.portFile : files.portFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(files.portFile, String(endpoint.port), { encoding: "utf8", mode: 0o600 });
  writeFileSync(files.tokenFile, endpoint.token, { encoding: "utf8", mode: 0o600 });
}

export function readEndpoint(files: { portFile: string; tokenFile: string }, host = "127.0.0.1"): DaemonEndpoint | null {
  try {
    if (!existsSync(files.portFile) || !existsSync(files.tokenFile)) return null;
    const port = Number(readFileSync(files.portFile, "utf8").trim());
    const token = readFileSync(files.tokenFile, "utf8").trim();
    if (!port || !token) return null;
    return { host, port, token };
  } catch {
    return null;
  }
}

export function clearEndpoint(files: { portFile: string; tokenFile: string }): void {
  for (const f of [files.portFile, files.tokenFile]) {
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      /* ignore */
    }
  }
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export interface IpcRequest {
  command: string;
  params?: Record<string, unknown>;
}

export interface IpcResponse {
  ok: boolean;
  data?: unknown;
  error?: { code: number; message: string };
}

export type IpcHandler = (req: IpcRequest) => Promise<unknown>;

export interface IpcServer {
  server: Server;
  endpoint: DaemonEndpoint;
  close(): Promise<void>;
}

export async function startIpcServer(opts: {
  host: string;
  token: string;
  handler: IpcHandler;
  onShutdownRequest?: () => void;
}): Promise<IpcServer> {
  const server = createServer((req, res) => void handleHttp(req, res, opts));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    endpoint: { host: opts.host, port, token: opts.token },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { token: string; handler: IpcHandler; onShutdownRequest?: () => void },
): Promise<void> {
  const send = (status: number, body: IpcResponse) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  if (req.method !== "POST") {
    send(405, { ok: false, error: { code: ExitCode.BAD_REQUEST, message: "只支持 POST" } });
    return;
  }
  const auth = req.headers["authorization"];
  const expected = `Bearer ${opts.token}`;
  if (auth !== expected) {
    send(401, { ok: false, error: { code: ExitCode.UNAUTHORIZED, message: "token 无效" } });
    return;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) {
      send(413, { ok: false, error: { code: ExitCode.BAD_REQUEST, message: "请求体过大" } });
      return;
    }
  }

  let parsed: IpcRequest;
  try {
    parsed = JSON.parse(raw || "{}") as IpcRequest;
  } catch {
    send(400, { ok: false, error: { code: ExitCode.BAD_REQUEST, message: "请求体不是合法 JSON" } });
    return;
  }

  try {
    const data = await opts.handler(parsed);
    send(200, { ok: true, data });
    if (parsed.command === "shutdown") opts.onShutdownRequest?.();
  } catch (err) {
    if (err instanceof BridgeError) {
      send(200, { ok: false, error: { code: err.code, message: err.message } });
    } else {
      send(200, { ok: false, error: { code: ExitCode.TASK_FAILED, message: (err as Error).message } });
    }
  }
}

/** Short-lived CLI side: send one request to the daemon. */
export async function ipcCall(endpoint: DaemonEndpoint, req: IpcRequest, timeoutMs = 30_000): Promise<IpcResponse> {
  // Use a one-off node:http request (agent:false, connection:close) instead of fetch:
  // undici's pooled keep-alive sockets race process.exit() on Windows and can trigger
  // a libuv assertion (0xC0000409). A non-pooled request closes cleanly.
  const payload = JSON.stringify(req);
  return await new Promise<IpcResponse>((resolve, reject) => {
    const r = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: "POST",
        path: "/",
        agent: false,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.token}`,
          "content-length": Buffer.byteLength(payload),
          connection: "close",
        },
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body || "{}") as IpcResponse);
          } catch (err) {
            reject(new BridgeError(ExitCode.UNAVAILABLE, `响应不是合法 JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    r.on("timeout", () => r.destroy(new BridgeError(ExitCode.UNAVAILABLE, "无法连接 Bridge Daemon: 超时")));
    r.on("error", (err) => reject(new BridgeError(ExitCode.UNAVAILABLE, `无法连接 Bridge Daemon: ${(err as Error).message}`)));
    r.write(payload);
    r.end();
  });
}

export { join };

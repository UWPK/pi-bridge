import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIpcServer, ipcCall, readEndpoint, writeEndpoint, clearEndpoint, newToken } from "../../src/ipc.js";
import { BridgeError, ExitCode } from "../../src/errors.js";

test("IPC server rejects requests without the correct token", async () => {
  const token = newToken();
  const server = await startIpcServer({
    host: "127.0.0.1",
    token,
    handler: async () => ({ ok: true }),
  });
  try {
    // correct token round-trips
    const good = await ipcCall({ host: "127.0.0.1", port: server.endpoint.port, token }, { command: "ping" });
    assert.equal(good.ok, true);

    // wrong token -> 401 handled by fetch path
    const bad = await fetch(`http://127.0.0.1:${server.endpoint.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ command: "ping" }),
    });
    assert.equal(bad.status, 401);
  } finally {
    await server.close();
  }
});

test("IPC handler errors are returned with their exit code and do not crash the server", async () => {
  const token = newToken();
  const server = await startIpcServer({
    host: "127.0.0.1",
    token,
    handler: async (req) => {
      if (req.command === "boom") throw new BridgeError(ExitCode.UNAUTHORIZED, "not allowed");
      return { ok: true };
    },
  });
  try {
    const resp = await ipcCall({ host: "127.0.0.1", port: server.endpoint.port, token }, { command: "boom" });
    assert.equal(resp.ok, false);
    assert.equal(resp.error?.code, ExitCode.UNAUTHORIZED);
    // server still alive
    const again = await ipcCall({ host: "127.0.0.1", port: server.endpoint.port, token }, { command: "ping" });
    assert.equal(again.ok, true);
  } finally {
    await server.close();
  }
});

test("IPC server binds loopback only", async () => {
  const server = await startIpcServer({ host: "127.0.0.1", token: newToken(), handler: async () => ({}) });
  try {
    const addr = server.server.address();
    assert.ok(typeof addr === "object" && addr);
    assert.equal((addr as { address: string }).address, "127.0.0.1");
  } finally {
    await server.close();
  }
});

test("endpoint files round-trip and clear", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-ep-"));
  const files = { portFile: join(dir, "daemon.port"), tokenFile: join(dir, "daemon.token") };
  try {
    writeEndpoint(files, { host: "127.0.0.1", port: 4321, token: "tok" });
    const read = readEndpoint(files, "127.0.0.1");
    assert.equal(read?.port, 4321);
    assert.equal(read?.token, "tok");
    clearEndpoint(files);
    assert.equal(readEndpoint(files, "127.0.0.1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ipcCall fails clearly when the daemon is unreachable", async () => {
  await assert.rejects(
    () => ipcCall({ host: "127.0.0.1", port: 1, token: "x" }, { command: "ping" }, 1000),
    (err: unknown) => err instanceof BridgeError && err.code === ExitCode.UNAVAILABLE,
  );
});

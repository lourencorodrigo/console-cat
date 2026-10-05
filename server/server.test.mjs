import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Minimal LSP client over the server's stdio.
function startServer() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))]);
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length: (\d+)/)[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
      pending.get(message.id)?.(message);
    }
  });
  const write = (message) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  return {
    request: (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        write({ id, method, params });
      }),
    notify: (method, params) => write({ method, params }),
    stop: () => child.kill(),
  };
}

const uri = "file:///project/server.js";
const text = `app.use(
  cors({
    origin: "http://localhost:3000", // 🌍 emoji before the cursor
  }),
);
user.lo
`;

test("language server: code action and postfix completion", async (t) => {
  const server = startServer();
  t.after(() => server.stop());

  const init = await server.request("initialize", { capabilities: {} });
  assert.ok(init.result.capabilities.codeActionProvider);
  server.notify("initialized", {});
  server.notify("textDocument/didOpen", { textDocument: { uri, languageId: "javascript", version: 1, text } });

  // Selecting `app` (line 0, chars 0–3).
  const actions = await server.request("textDocument/codeAction", {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    context: { diagnostics: [] },
  });
  assert.equal(actions.result.length, 1);
  assert.equal(actions.result[0].title, "🐱 Console Cat: log app");
  assert.deepEqual(actions.result[0].edit.changes[uri], [
    { range: { start: { line: 4, character: 2 }, end: { line: 4, character: 2 } }, newText: "\nconsole.log('🐱 ~ app:', app);" },
  ]);

  // Typing `user.lo` on line 5.
  const completion = await server.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 5, character: 7 },
  });
  const [item] = completion.result;
  assert.equal(item.label, "log");
  assert.deepEqual(item.textEdit, {
    range: { start: { line: 5, character: 0 }, end: { line: 5, character: 7 } },
    newText: "console.log('🐱 ~ user:', user);",
  });

  // After an edit, the server sees the new text (full sync).
  server.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: "const x = 1;\n" }],
  });
  const none = await server.request("textDocument/codeAction", {
    textDocument: { uri },
    range: { start: { line: 0, character: 12 }, end: { line: 0, character: 12 } },
    context: { diagnostics: [] },
  });
  assert.deepEqual(none.result, []);

  const shutdown = await server.request("shutdown", null);
  assert.equal(shutdown.result, null);
});

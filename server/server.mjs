// Console Cat language server: offers a "log" code action for the selection and a
// `.log` postfix completion. Speaks LSP (JSON-RPC over stdio) with no dependencies.
import { fileURLToPath } from "node:url";
import { logEdit, postfixEdit } from "./console-cat.mjs";

const documents = new Map(); // uri → { text, fileName }

// Zed language ids → a file name the parser understands, for untitled buffers.
const EXTENSION_BY_LANGUAGE = {
  javascript: ".js",
  javascriptreact: ".jsx",
  typescript: ".ts",
  typescriptreact: ".tsx",
  tsx: ".tsx",
  vue: ".vue",
  svelte: ".svelte",
};

function fileNameOf(uri, languageId) {
  try {
    const path = uri.startsWith("file:") ? fileURLToPath(uri) : new URL(uri).pathname;
    if (/\.[a-z]+$/i.test(path)) return path;
  } catch {}
  return `untitled${EXTENSION_BY_LANGUAGE[languageId?.toLowerCase()] ?? ".tsx"}`;
}

// LSP positions are UTF-16 based, like JavaScript string offsets.
function offsetAt(text, { line, character }) {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  const end = text.indexOf("\n", offset);
  return Math.min(offset + character, end === -1 ? text.length : end);
}

function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

function insertion(text, offset, newText) {
  const position = positionAt(text, offset);
  return { range: { start: position, end: position }, newText };
}

function codeActions({ textDocument, range }) {
  const doc = documents.get(textDocument.uri);
  if (!doc) return [];
  const edit = logEdit(doc.text, {
    fileName: doc.fileName,
    start: offsetAt(doc.text, range.start),
    end: offsetAt(doc.text, range.end),
  });
  if (!edit) return [];
  const label = edit.expr.replace(/\s+/g, " ");
  return [
    {
      title: `🐱 Console Cat: log ${label.length > 40 ? `${label.slice(0, 40)}…` : label}`,
      kind: "refactor",
      edit: { changes: { [textDocument.uri]: [insertion(doc.text, edit.offset, edit.newText)] } },
    },
  ];
}

function completions({ textDocument, position }) {
  const doc = documents.get(textDocument.uri);
  if (!doc) return [];
  const offset = offsetAt(doc.text, position);
  const edit = postfixEdit(doc.text, { fileName: doc.fileName, offset });
  if (!edit) return [];
  return [
    {
      label: "log",
      kind: 15, // Snippet
      detail: "🐱 Console Cat",
      documentation: `console.log('🐱 ~ ${edit.expr}:', ${edit.expr});`,
      sortText: "0",
      filterText: "log",
      textEdit: {
        range: { start: positionAt(doc.text, edit.replace.start), end: positionAt(doc.text, edit.replace.end) },
        newText: edit.replace.newText,
      },
      additionalTextEdits: edit.insert ? [insertion(doc.text, edit.insert.offset, edit.insert.newText)] : [],
    },
  ];
}

const handlers = {
  initialize: () => ({
    capabilities: {
      textDocumentSync: { openClose: true, change: 1 }, // full sync
      codeActionProvider: { codeActionKinds: ["refactor"] },
      completionProvider: { triggerCharacters: ["."] },
    },
    serverInfo: { name: "console-cat" },
  }),
  shutdown: () => null,
  "textDocument/codeAction": codeActions,
  "textDocument/completion": completions,
};

const notifications = {
  "textDocument/didOpen": ({ textDocument }) =>
    documents.set(textDocument.uri, {
      text: textDocument.text,
      fileName: fileNameOf(textDocument.uri, textDocument.languageId),
    }),
  "textDocument/didChange": ({ textDocument, contentChanges }) => {
    const doc = documents.get(textDocument.uri);
    const last = contentChanges.at(-1);
    if (doc && last) doc.text = last.text;
  },
  "textDocument/didClose": ({ textDocument }) => documents.delete(textDocument.uri),
  exit: () => process.exit(0),
};

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function dispatch({ id, method, params }) {
  if (id === undefined) {
    notifications[method]?.(params);
    return;
  }
  const handler = handlers[method];
  if (!handler) {
    send({ id, error: { code: -32601, message: `Unhandled method ${method}` } });
    return;
  }
  try {
    send({ id, result: handler(params) });
  } catch (error) {
    send({ id, error: { code: -32603, message: String(error?.stack ?? error) } });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length: *(\d+)/i)?.[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    dispatch(JSON.parse(body));
  }
});

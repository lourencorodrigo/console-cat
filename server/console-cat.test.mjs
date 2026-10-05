import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, logEdit, postfixEdit } from "./console-cat.mjs";

// `|` marks the cursor; `«...»` marks the selection.
function run(source, fileName = "file.js") {
  const clean = source.replace(/[|«»]/g, "");
  const cursor = source.indexOf("|");
  const start = cursor !== -1 ? cursor : source.indexOf("«");
  const end = cursor !== -1 ? cursor : source.indexOf("»") - 1;
  const edit = logEdit(clean, { fileName, start, end });
  return edit && applyEdit(clean, edit);
}

// Applies the postfix completion at `|` (replace + optional insertion after it).
function postfix(source, fileName = "file.js") {
  const offset = source.indexOf("|");
  const clean = source.replace("|", "");
  const edit = postfixEdit(clean, { fileName, offset });
  if (!edit) return null;
  const { replace, insert } = edit;
  const replaced = clean.slice(0, replace.start) + replace.newText + clean.slice(replace.end);
  if (!insert) return replaced;
  // `insert` is relative to the original text; shift it if it comes after the replacement.
  const shift = insert.offset >= replace.end ? replace.newText.length - (replace.end - replace.start) : 0;
  return applyEdit(replaced, { offset: insert.offset + shift, newText: insert.newText });
}

test("logs after a multi-line call instead of inside it", () => {
  const out = run(`«app».use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? process.env.FRONTEND_URL
        : "http://localhost:3000",
    credentials: true, // Allow cookies to be sent
  }),
);
`);
  assert.equal(
    out,
    `app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? process.env.FRONTEND_URL
        : "http://localhost:3000",
    credentials: true, // Allow cookies to be sent
  }),
);
console.log('🐱 ~ app:', app);
`,
  );
});

test("logs after the whole statement when the selection is deep inside it", () => {
  const out = run(`app.use(
  cors({ origin: «process.env.FRONTEND_URL» }),
);
`);
  assert.match(out, /\);\nconsole\.log\('🐱 ~ process\.env\.FRONTEND_URL:', process\.env\.FRONTEND_URL\);\n$/);
});

test("simple declaration keeps indentation", () => {
  const out = run(`function f() {
  const «user» = getUser();
}
`);
  assert.equal(
    out,
    `function f() {
  const user = getUser();
  console.log('🐱 ~ user:', user);
}
`,
  );
});

test("uses the word under the cursor when nothing is selected", () => {
  const out = run(`const city = user.address.ci|ty;
`);
  assert.equal(out, `const city = user.address.city;\nconsole.log('🐱 ~ user.address.city:', user.address.city);\n`);
});

test("logs before return", () => {
  const out = run(`function f(user) {
  return «user»;
}
`);
  assert.equal(out, `function f(user) {\n  console.log('🐱 ~ user:', user);\n  return user;\n}\n`);
});

test("function parameter logs at the start of the body", () => {
  const out = run(`function f(«req», res) {
  res.send("ok");
}
`);
  assert.equal(out, `function f(req, res) {\n  console.log('🐱 ~ req:', req);\n  res.send("ok");\n}\n`);
});

test("arrow callback parameter logs inside the callback", () => {
  const out = run(`app.get("/", («req», res) => {
  res.send("ok");
});
`);
  assert.equal(out, `app.get("/", (req, res) => {\n  console.log('🐱 ~ req:', req);\n  res.send("ok");\n});\n`);
});

test("statement inside a callback stays inside the callback", () => {
  const out = run(`app.get("/", (req, res) => {
  const «body» = req.body;
  res.send(body);
});
`);
  assert.equal(
    out,
    `app.get("/", (req, res) => {\n  const body = req.body;\n  console.log('🐱 ~ body:', body);\n  res.send(body);\n});\n`,
  );
});

test("for-of variable logs at the start of the loop body", () => {
  const out = run(`for (const «item» of items) {
  process(item);
}
`);
  assert.equal(out, `for (const item of items) {\n  console.log('🐱 ~ item:', item);\n  process(item);\n}\n`);
});

test("if condition logs before the if", () => {
  const out = run(`if («user») {
  go();
}
`);
  assert.equal(out, `console.log('🐱 ~ user:', user);\nif (user) {\n  go();\n}\n`);
});

test("escapes quotes in the label", () => {
  const out = run(`const x = «obj['key']»;
`);
  assert.equal(out, `const x = obj['key'];\nconsole.log('🐱 ~ obj[\\'key\\']:', obj['key']);\n`);
});

test("typescript", () => {
  const out = run(`const «user»: User = getUser<User>();
`, "file.ts");
  assert.equal(out, `const user: User = getUser<User>();\nconsole.log('🐱 ~ user:', user);\n`);
});

test("vue script block", () => {
  const out = run(`<template><div /></template>
<script setup lang="ts">
const «count» = ref(0);
</script>
`, "file.vue");
  assert.equal(out, `<template><div /></template>\n<script setup lang="ts">\nconst count = ref(0);\nconsole.log('🐱 ~ count:', count);\n</script>\n`);
});

test("returns null when there is nothing to log", () => {
  assert.equal(run(`const x = 1;\n|\n`), null);
});

test("postfix: standalone `expr.log` becomes the console.log", () => {
  assert.equal(postfix(`function f() {\n  user.address.log|\n}\n`), `function f() {\n  console.log('🐱 ~ user.address:', user.address);\n}\n`);
});

test("postfix: keeps an existing semicolon", () => {
  assert.equal(postfix(`user.lo|;\n`), `console.log('🐱 ~ user:', user);\n`);
});

test("postfix: inside a statement logs after the statement", () => {
  assert.equal(
    postfix(`app.use(\n  cors({ origin: url.log| }),\n);\n`),
    `app.use(\n  cors({ origin: url }),\n);\nconsole.log('🐱 ~ url:', url);\n`,
  );
});

test("postfix: inside a return logs before it", () => {
  assert.equal(
    postfix(`function f() {\n  return user.log|;\n}\n`),
    `function f() {\n  console.log('🐱 ~ user:', user);\n  return user;\n}\n`,
  );
});

test("postfix: only offered for prefixes of `log`", () => {
  assert.equal(postfix(`user.map|\n`), null);
  assert.notEqual(postfix(`user.|\n`), null);
});

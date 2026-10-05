// Console Cat: computes where `console.log('🐱 ~ <expr>:', <expr>);` goes for an
// expression, using the TypeScript parser to find statement boundaries.
import { extname } from "node:path";
import ts from "typescript";

const PREFIX = "🐱 ~ ";
const POSTFIX = "log";

const SCRIPT_KINDS = {
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
};

// Parents whose children are a list of statements (where a console.log can live).
function isStatementList(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

function isLoop(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node)
  );
}

function within(node, start, end, sourceFile) {
  return node.getStart(sourceFile) <= start && end <= node.getEnd();
}

function findDeepestNode(sourceFile, start, end) {
  let found = sourceFile;
  const visit = (node) => {
    if (within(node, start, end, sourceFile)) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

// With no selection, use the identifier under the cursor, extended to the whole
// property chain when the cursor is on a property name (`user.address.city`).
function expressionAtCursor(sourceFile, offset) {
  let node = findDeepestNode(sourceFile, offset, offset);
  if (!ts.isIdentifier(node) && !ts.isPrivateIdentifier(node)) {
    node = findDeepestNode(sourceFile, Math.max(0, offset - 1), Math.max(0, offset - 1));
  }
  if (!ts.isIdentifier(node) && !ts.isPrivateIdentifier(node)) return null;
  while (
    node.parent &&
    (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
    node.parent.name === node
  ) {
    node = node.parent;
  }
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

function lineStart(text, pos) {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(text, pos) {
  const i = text.indexOf("\n", pos);
  return i === -1 ? text.length : i;
}

function indentAt(text, pos) {
  const start = lineStart(text, pos);
  return text.slice(start).match(/^[ \t]*/)[0];
}

function indentUnit(text) {
  const m = text.match(/^(\t| {2,})\S/m);
  return m ? m[1] : "  ";
}

// Where to put the log for the statement-list child `stmt` that contains the selection.
function placement(stmt, selectionNode, sourceFile, text) {
  // `return x;` / `throw x;`: code after them is unreachable, log before.
  if (
    ts.isReturnStatement(stmt) ||
    ts.isThrowStatement(stmt) ||
    ts.isBreakStatement(stmt) ||
    ts.isContinueStatement(stmt)
  ) {
    return { mode: "before", pos: stmt.getStart(sourceFile) };
  }

  // Selection in a loop header (`for (const item of items)`): log at the start of the body.
  if (isLoop(stmt) && ts.isBlock(stmt.statement) && !within(stmt.statement, selectionNode.getStart(sourceFile), selectionNode.getEnd(), sourceFile)) {
    return bodyStart(stmt.statement, sourceFile, text);
  }

  // Selection in an `if`/`switch` condition: log before, the value is already in scope.
  if ((ts.isIfStatement(stmt) || ts.isSwitchStatement(stmt)) && within(stmt.expression, selectionNode.getStart(sourceFile), selectionNode.getEnd(), sourceFile)) {
    return { mode: "before", pos: stmt.getStart(sourceFile) };
  }

  return { mode: "after", pos: stmt.getEnd(), indent: indentAt(text, stmt.getStart(sourceFile)) };
}

function bodyStart(block, sourceFile, text) {
  const first = block.statements[0];
  const indent = first
    ? indentAt(text, first.getStart(sourceFile))
    : indentAt(text, block.getStart(sourceFile)) + indentUnit(text);
  return { mode: "after", pos: block.getStart(sourceFile) + 1, indent };
}

function findPlacement(sourceFile, start, end, text) {
  const selectionNode = findDeepestNode(sourceFile, start, end);
  for (let node = selectionNode; node && node.parent; node = node.parent) {
    // Function parameter: log at the start of the function body.
    if (ts.isParameter(node) && node.parent.body && ts.isBlock(node.parent.body)) {
      return bodyStart(node.parent.body, sourceFile, text);
    }
    if (isStatementList(node.parent)) {
      return placement(node, selectionNode, sourceFile, text);
    }
  }
  return null;
}

function escapeLabel(label) {
  return label.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function logStatement(expr) {
  return `console.log('${PREFIX}${escapeLabel(expr)}:', ${expr})`;
}

// Vue/Svelte: only the <script> block that contains the cursor is parsed.
function scriptRegion(text, ext, offset) {
  if (ext !== ".vue" && ext !== ".svelte") {
    return { start: 0, end: text.length, kind: SCRIPT_KINDS[ext] ?? ts.ScriptKind.TSX };
  }
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (let m; (m = re.exec(text)); ) {
    const start = m.index + m[0].indexOf(">") + 1;
    const end = start + m[2].length;
    if (start <= offset && offset <= end) {
      const kind = /lang=["']?(ts|tsx)/.test(m[1]) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
      return { start, end, kind };
    }
  }
  return null;
}

function parse(text, fileName, offset) {
  const region = scriptRegion(text, extname(fileName).toLowerCase(), offset);
  if (!region) return null;
  const code = text.slice(region.start, region.end);
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, region.kind);
  return { region, code, sourceFile };
}

/**
 * Edit that inserts the console.log for the selection [start, end), or for the
 * expression under the cursor when start === end. Returns `{ offset, newText, expr }`
 * (an insertion at `offset`) or null when there is nothing to log.
 */
export function logEdit(text, { fileName, start, end = start }) {
  const parsed = parse(text, fileName, start);
  if (!parsed) return null;
  const { region, code, sourceFile } = parsed;

  let range;
  if (end > start) {
    // Ignore whitespace around the selection.
    const selected = text.slice(start, end);
    const lead = selected.length - selected.trimStart().length;
    const trail = selected.length - selected.trimEnd().length;
    if (lead === selected.length) return null;
    range = { start: start + lead - region.start, end: end - trail - region.start };
  } else {
    range = expressionAtCursor(sourceFile, start - region.start);
    if (!range) return null;
  }

  const target = findPlacement(sourceFile, range.start, range.end, code);
  if (!target) return null;

  const expr = code.slice(range.start, range.end);
  const log = `${logStatement(expr)};`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";

  let insertAt;
  let newText;
  if (target.mode === "before") {
    insertAt = lineStart(code, target.pos);
    newText = `${indentAt(code, target.pos)}${log}${eol}`;
  } else {
    // After the statement's line, so trailing comments stay on their line.
    insertAt = lineEnd(code, target.pos);
    if (code[insertAt - 1] === "\r") insertAt -= 1;
    newText = `${eol}${target.indent}${log}`;
  }

  return { offset: region.start + insertAt, newText, expr };
}

// `user.address.lo|` → expression `user.address`, typed postfix `lo`.
const POSTFIX_RE = /(?<![\w$.])((?:this|[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$#][\w$]*|\[[^\[\]\n]*\]|\([^()\n]*\))*)\.([A-Za-z]*)$/;

/**
 * Postfix completion: typing `expr.log` turns into the console.log.
 * Returns `{ replace: { start, end, newText }, insert: { offset, newText } | null, expr }`
 * where `replace` covers `expr.log` (single line, ending at the cursor), or null.
 */
export function postfixEdit(text, { fileName, offset }) {
  const before = text.slice(lineStart(text, offset), offset);
  const m = before.match(POSTFIX_RE);
  if (!m || !POSTFIX.startsWith(m[2])) return null;

  const expr = m[1];
  const exprStart = offset - m[0].length;
  const exprEnd = exprStart + expr.length;
  // The document as it will be once `.log` is removed.
  const withoutPostfix = text.slice(0, exprEnd) + text.slice(offset);

  const parsed = parse(withoutPostfix, fileName, exprStart);
  if (!parsed) return null;
  const { region, sourceFile } = parsed;

  // `user.log` alone on its statement: replace it with the console.log itself.
  let node = findDeepestNode(sourceFile, exprStart - region.start, exprEnd - region.start);
  while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const statement = node.parent;
  if (statement && ts.isExpressionStatement(statement) && statement.expression === node) {
    const hasSemicolon = withoutPostfix[statement.getEnd() + region.start - 1] === ";";
    return {
      replace: { start: exprStart, end: offset, newText: logStatement(expr) + (hasSemicolon ? "" : ";") },
      insert: null,
      expr,
    };
  }

  // Inside a larger statement: keep `user` and log after the statement.
  const edit = logEdit(withoutPostfix, { fileName, start: exprStart, end: exprEnd });
  if (!edit) return null;
  const insertOffset = edit.offset <= exprStart ? edit.offset : edit.offset + (offset - exprEnd);
  return {
    replace: { start: exprStart, end: offset, newText: expr },
    insert: { offset: insertOffset, newText: edit.newText },
    expr,
  };
}

export function applyEdit(text, { offset, newText }) {
  return text.slice(0, offset) + newText + text.slice(offset);
}

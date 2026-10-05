# Console Cat 🐱

A [Zed](https://zed.dev) extension that logs the selected expression with `console.log` in JavaScript/TypeScript files. Install it and it works: no CLI, no configuration.

```js
const user = getUser();
console.log('🐱 ~ user:', user);
```

## Usage

- **Code action:** select an expression (or put the cursor on it) and press `cmd-.` → **🐱 Console Cat: log user**.
- **Postfix completion:** type `user.log` and accept the `log` suggestion.

The log goes **after the whole statement** that contains the expression, even when it spans several lines:

```js
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
  }),
);
console.log('🐱 ~ app:', app);
```

| Expression | Where the log goes |
| --- | --- |
| Inside a statement | After the end of the statement |
| In a `return` / `throw` | Before it |
| A function or callback parameter | First line of the function body |
| A `for` / `for...of` variable | First line of the loop body |
| In an `if` / `switch` condition | Before it |
| `user.log` alone on its line | Replaced by the `console.log` |

Works in JavaScript, TypeScript and TSX files, and in `<script>` blocks of Vue and Svelte files (with their Zed extensions installed).

### Optional: ctrl + option + L

Zed extensions can't register keybindings. To open the code actions menu with `ctrl-alt-l`, add [`keymap.json`](./keymap.json) to `~/.config/zed/keymap.json` (`zed: open keymap`).

## How it works

Zed extensions can't edit buffers directly, so Console Cat is a small language server:

- `server/server.mjs` speaks LSP over stdio and offers the code action and the `.log` completion.
- `server/console-cat.mjs` parses the file with the TypeScript compiler API to find where the statement ends.
- `src/lib.rs` (the Zed extension) embeds both files, writes them to the extension's work directory, installs `typescript` with Zed's built-in npm and starts the server with Zed's built-in Node.

The edit is applied by Zed like any refactoring, so `cmd-z` undoes it.

## Development

Requirements: [rustup](https://rustup.rs) (Zed compiles the extension to `wasm32-wasip2`) and Node.js for the tests.

1. `npm install`, then `npm test`
2. Open Zed → `zed: extensions` → **Install Dev Extension** and select this folder
3. After changing `server/` or `src/`, click **Rebuild** on the extension
4. Logs: `zed: open log` (or run `zed --foreground`)

## Structure

```
extension.toml   # extension manifest (registers the language server)
Cargo.toml       # Rust crate (cdylib → wasm)
src/lib.rs       # installs and starts the language server
server/          # language server (console-cat.mjs, server.mjs) and tests
keymap.json      # optional ctrl+option+L binding
```

Reference: https://zed.dev/docs/extensions/developing-extensions

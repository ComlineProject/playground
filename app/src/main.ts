import type { CompileResult, GenerateResult } from "./worker.ts";

const SAMPLE = `struct Message {
    body: string
    seq: u64
}

error Rejected {
    message = "rejected: {self.reason}"
    reason: string
}

@framing = "jsonrpc"
protocol Chat {
    /// Request/response with a raised error.
    function send(text: string) -> Message ! Rejected;
    /// Fire-and-forget.
    function note(text: string);
}
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const editor = $<HTMLTextAreaElement>("#editor");
const highlightEl = $<HTMLElement>("#editor-hl code");
const statusEl = $<HTMLSpanElement>("#status");
const viewEl = $<HTMLDivElement>("#view");
const tabsEl = $<HTMLDivElement>("#tabs");
const outputControls = $<HTMLDivElement>("#output-controls");
const targetSel = $<HTMLSelectElement>("#target");
const modeSel = $<HTMLSelectElement>("#mode");

type View = "diagnostics" | "ir" | "output";
let view: View = "diagnostics";
let lastCompile: CompileResult | null = null;

// ── worker plumbing ────────────────────────────────────────────────────────
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let seq = 0;
const pending = new Map<number, (v: unknown) => void>();

worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
  const resolve = pending.get(e.data.id);
  if (!resolve) return;
  pending.delete(e.data.id);
  resolve(e.data.error ? { __error: e.data.error } : e.data.result);
};

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve as (v: unknown) => void);
    worker.postMessage({ id, ...msg });
  });
}

// ── render ─────────────────────────────────────────────────────────────────
function lineCol(src: string, offset: number): string {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return `${line}:${col}`;
}

function renderDiagnostics(src: string, res: CompileResult) {
  if (res.diagnostics.length === 0) {
    viewEl.innerHTML = `<p class="ok">no problems — ${res.units} declaration${
      res.units === 1 ? "" : "s"
    }</p>`;
    return;
  }
  viewEl.innerHTML =
    `<ul class="diagnostics">` +
    res.diagnostics
      .map(
        (d) =>
          `<li><span class="loc">${lineCol(src, d.start)}</span> ${escapeHtml(d.message)}</li>`,
      )
      .join("") +
    `</ul>`;
}

async function renderOutput() {
  outputControls.hidden = view !== "output";
  const src = editor.value;

  if (view === "diagnostics") {
    if (lastCompile) renderDiagnostics(src, lastCompile);
    return;
  }
  if (view === "ir") {
    viewEl.innerHTML = lastCompile?.ir
      ? `<pre class="code">${escapeHtml(lastCompile.ir)}</pre>`
      : `<p class="muted">schema does not parse</p>`;
    return;
  }
  // output
  viewEl.innerHTML = `<p class="muted">generating…</p>`;
  const res = await call<GenerateResult | { __error: string }>({
    cmd: "generate",
    source: src,
    target: targetSel.value,
    mode: modeSel.value,
  });
  if ("__error" in res) {
    viewEl.innerHTML = `<p class="err">${escapeHtml(res.__error)}</p>`;
    return;
  }
  if (res.error) {
    viewEl.innerHTML = `<p class="err">${escapeHtml(res.error)}</p>`;
    return;
  }
  viewEl.innerHTML = res.files
    .map(
      (f) =>
        `<div class="file"><div class="file-name">${escapeHtml(f.path)}</div>` +
        `<pre class="code">${escapeHtml(f.contents)}</pre></div>`,
    )
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// ── editor: syntax highlight + tab ─────────────────────────────────────────
const KEYWORDS = new Set([
  "struct", "enum", "protocol", "error", "const", "use", "import",
  "validator", "settings", "function", "optional",
]);
const PRIMS = new Set([
  "s8", "s16", "s32", "s64", "u8", "u16", "u32", "u64", "f32", "f64",
  "bool", "str", "string", "int", "float",
]);
// comment | string | @annotation | number | identifier | `->` or punctuation
const TOKEN_RE =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|(@[A-Za-z_]\w*)|(\b\d[\w.]*)|([A-Za-z_]\w*)|(->|[{}()[\];:,!.=|])/g;

function highlight(src: string): void {
  let out = "";
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(src); m; m = TOKEN_RE.exec(src)) {
    out += escapeHtml(src.slice(last, m.index));
    const [full, comment, str, ann, num, ident, punct] = m;
    if (comment) out += span("comment", full);
    else if (str) out += span("str", full);
    else if (ann) out += span("ann", full);
    else if (num) out += span("num", full);
    else if (ident) {
      const cls = KEYWORDS.has(ident)
        ? "kw"
        : PRIMS.has(ident) || /^[A-Z]/.test(ident)
          ? "type"
          : null;
      out += cls ? span(cls, full) : escapeHtml(full);
    } else if (punct) out += span("punct", full);
    last = m.index + full.length;
  }
  out += escapeHtml(src.slice(last)) + "\n";
  highlightEl.innerHTML = out;
}
const span = (cls: string, text: string) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

function syncScroll(): void {
  const pre = highlightEl.parentElement!;
  pre.scrollTop = editor.scrollTop;
  pre.scrollLeft = editor.scrollLeft;
}

const INDENT = "    ";
editor.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const { selectionStart: s, selectionEnd: en, value } = editor;

  if (s === en && !e.shiftKey) {
    document.execCommand("insertText", false, INDENT); // keeps native undo
    return;
  }

  // (de)indent every line the selection touches
  const from = value.lastIndexOf("\n", s - 1) + 1;
  const block = value.slice(from, en);
  const next = e.shiftKey
    ? block.replace(/^( {1,4}|\t)/gm, "")
    : block.replace(/^(?!$)/gm, INDENT); // indent non-empty lines
  editor.setRangeText(next, from, en, "select");
  editor.dispatchEvent(new Event("input"));
});

// ── loop ───────────────────────────────────────────────────────────────────
let debounce: number | undefined;
async function run() {
  const src = editor.value;
  const res = await call<CompileResult | { __error: string }>({ cmd: "compile", source: src });
  if ("__error" in res) {
    statusEl.textContent = "wasm error";
    statusEl.className = "status err";
    viewEl.innerHTML = `<p class="err">${escapeHtml(res.__error)}</p>`;
    return;
  }
  lastCompile = res;
  const n = res.diagnostics.length;
  statusEl.textContent = res.ir === null ? "syntax error" : n === 0 ? "ok" : `${n} problem${n === 1 ? "" : "s"}`;
  statusEl.className = `status ${n === 0 && res.ir !== null ? "ok" : "err"}`;
  void renderOutput();
}

editor.addEventListener("input", () => {
  highlight(editor.value);
  window.clearTimeout(debounce);
  debounce = window.setTimeout(run, 200);
});
editor.addEventListener("scroll", syncScroll);
tabsEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  for (const b of tabsEl.querySelectorAll("button")) b.classList.remove("active");
  btn.classList.add("active");
  view = btn.dataset.view as View;
  void renderOutput();
});
for (const el of [targetSel, modeSel]) el.addEventListener("change", () => void renderOutput());

editor.value = SAMPLE;
highlight(SAMPLE);
statusEl.textContent = "compiling…";
void run();

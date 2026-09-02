import type {
  CompileResult,
  CompletionItem,
  GenerateResult,
  Hover,
  SemanticTokens,
} from "./worker.ts";
import { createEditor, type EditorBridge } from "./editor.ts";

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

const statusEl = $<HTMLSpanElement>("#status");
const viewEl = $<HTMLDivElement>("#view");
const tabsEl = $<HTMLDivElement>("#tabs");
const outputControls = $<HTMLDivElement>("#output-controls");
const targetSel = $<HTMLSelectElement>("#target");
const modeSel = $<HTMLSelectElement>("#mode");

type View = "diagnostics" | "ir" | "output";
let view: View = "diagnostics";
let lastCompile: CompileResult | null = null;
let doc = SAMPLE;

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

async function unwrap<T>(msg: Record<string, unknown>, fallback: T): Promise<T> {
  const r = await call<T | { __error: string }>(msg);
  if (r && typeof r === "object" && "__error" in r) {
    statusEl.textContent = "wasm error";
    statusEl.className = "status err";
    return fallback;
  }
  return r as T;
}

const bridge: EditorBridge = {
  compile: (source) => unwrap<CompileResult>({ cmd: "compile", source }, blankCompile()),
  semanticTokens: (source) =>
    unwrap<SemanticTokens>({ cmd: "semanticTokens", source }, { data: [] }),
  hover: (source, line, character) =>
    unwrap<Hover | null>({ cmd: "hover", source, line, character }, null),
  completions: (source, line, character) =>
    unwrap<CompletionItem[]>({ cmd: "completions", source, line, character }, []),
};

function blankCompile(): CompileResult {
  return { ok: false, diagnostics: [], ir: null, units: 0 };
}

// ── panels ─────────────────────────────────────────────────────────────────
function renderDiagnostics(res: CompileResult) {
  if (res.diagnostics.length === 0) {
    viewEl.innerHTML = `<p class="ok">no problems — ${res.units} declaration${
      res.units === 1 ? "" : "s"
    }</p>`;
    return;
  }
  viewEl.innerHTML =
    `<ul class="diagnostics">` +
    res.diagnostics
      .map((d) => {
        const at = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
        return `<li><span class="loc">${at}</span> ${escapeHtml(d.message)}</li>`;
      })
      .join("") +
    `</ul>`;
}

async function renderOutput() {
  outputControls.hidden = view !== "output";

  if (view === "diagnostics") {
    if (lastCompile) renderDiagnostics(lastCompile);
    return;
  }
  if (view === "ir") {
    viewEl.innerHTML = lastCompile?.ir
      ? `<pre class="code">${escapeHtml(lastCompile.ir)}</pre>`
      : `<p class="muted">schema does not parse</p>`;
    return;
  }
  viewEl.innerHTML = `<p class="muted">generating…</p>`;
  const res = await unwrap<GenerateResult>(
    { cmd: "generate", source: doc, target: targetSel.value, mode: modeSel.value },
    { files: [], error: "wasm error" },
  );
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
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// ── loop ───────────────────────────────────────────────────────────────────
let debounce: number | undefined;
async function refresh() {
  const res = await bridge.compile(doc);
  lastCompile = res;
  const n = res.diagnostics.length;
  statusEl.textContent = res.ir === null ? "syntax error" : n === 0 ? "ok" : `${n} problem${n === 1 ? "" : "s"}`;
  statusEl.className = `status ${n === 0 && res.ir !== null ? "ok" : "err"}`;
  void renderOutput();
}

createEditor($<HTMLDivElement>("#editor"), SAMPLE, bridge, (next) => {
  doc = next;
  window.clearTimeout(debounce);
  debounce = window.setTimeout(refresh, 200);
});

tabsEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  for (const b of tabsEl.querySelectorAll("button")) b.classList.remove("active");
  btn.classList.add("active");
  view = btn.dataset.view as View;
  void renderOutput();
});
for (const el of [targetSel, modeSel]) el.addEventListener("change", () => void renderOutput());

statusEl.textContent = "compiling…";
void refresh();

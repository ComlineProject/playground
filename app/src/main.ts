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
  window.clearTimeout(debounce);
  debounce = window.setTimeout(run, 200);
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

editor.value = SAMPLE;
statusEl.textContent = "compiling…";
void run();

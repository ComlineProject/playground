import { forceLinting } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { makeState, mountEditor, type EditorBridge, type EditorContext } from "./editor.ts";
import type {
  CompileProjectResult,
  CompletionItem,
  FileInput,
  GenerateResult,
  Hover,
  LspPosition,
  SemanticTokens,
} from "./worker.ts";

// ── sample: two files, one `use`ing the other ────────────────────────────
const SAMPLE_FILES: { name: string; doc: string }[] = [
  {
    name: "types.comline",
    doc: `struct Message {
    body: string
    seq: u64
}
`,
  },
  {
    name: "chat.comline",
    doc: `use types::Message

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
`,
  },
];

// ── virtual file set ────────────────────────────────────────────────────
interface SchemaFile {
  id: string;
  name: string;
  doc: string; // kept in sync with `state` while the file is active
  state: EditorState;
}

let files: SchemaFile[] = [];
let activeId = "";
let uid = 0;
const nextId = () => `f${++uid}`;

const activeFile = () => files.find((f) => f.id === activeId)!;
const project = (): FileInput[] => files.map((f) => ({ path: f.name, source: f.doc }));

// ── DOM ─────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $<HTMLSpanElement>("#status");
const viewEl = $<HTMLDivElement>("#view");
const tabsEl = $<HTMLDivElement>("#tabs");
const modeEl = $<HTMLDivElement>("#mode");
const targetSel = $<HTMLSelectElement>("#target");
const filesEl = $<HTMLDivElement>("#files");
const activeNameEl = $<HTMLSpanElement>("#active-name");
const editorEl = $<HTMLDivElement>("#editor");

type View = "problems" | "ir" | "output";
let currentView: View = "problems";
let mode: "code" | "lib" = "code";
let lastProject: CompileProjectResult | null = null;

// ── worker plumbing ─────────────────────────────────────────────────────
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
  compileProject: (f) =>
    unwrap<CompileProjectResult>({ cmd: "compileProject", files: f }, { files: [] }),
  semanticTokens: (source) =>
    unwrap<SemanticTokens>({ cmd: "semanticTokens", source }, { data: [] }),
  hover: (source, line, character) =>
    unwrap<Hover | null>({ cmd: "hover", source, line, character }, null),
  completions: (source, line, character) =>
    unwrap<CompletionItem[]>({ cmd: "completions", source, line, character }, []),
};

// ── editor ──────────────────────────────────────────────────────────────
const ctx: EditorContext = {
  bridge,
  project,
  activeName: () => activeFile().name,
  onDocChanged: (d) => {
    activeFile().doc = d;
    scheduleRefresh();
  },
};

let view!: EditorView; // assigned in boot, before any handler can fire

function switchTo(id: string) {
  if (id === activeId) return;
  const cur = activeFile();
  if (cur) cur.state = view.state;
  activeId = id;
  view.setState(activeFile().state);
  activeNameEl.textContent = activeFile().name;
  renderFiles();
  if (currentView === "ir") renderView();
  forceLinting(view);
}

function jumpTo(fileName: string, pos: LspPosition) {
  const f = files.find((x) => x.name === fileName);
  if (!f) return;
  switchTo(f.id);
  const { doc } = view.state;
  const line = doc.line(Math.min(pos.line + 1, doc.lines));
  const at = Math.min(line.from + pos.character, line.to);
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  view.focus();
}

// ── file strip ─────────────────────────────────────────────────────────
function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
function extName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : ".comline";
}

function uniqueName(name: string, exceptId?: string): string {
  const taken = (n: string) => files.some((f) => f.id !== exceptId && f.name === n);
  if (!taken(name)) return name;
  const base = baseName(name);
  const ext = extName(name);
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

function promptName(title: string, def: string): string {
  const raw = window.prompt(title, def);
  if (raw === null) return "";
  let name = raw.trim();
  if (!name) return "";
  if (!name.includes(".")) name += ".comline";
  return name;
}

function addFile() {
  let n = files.length + 1;
  while (files.some((f) => f.name === `schema${n}.comline`)) n++;
  const name = promptName("new schema file", `schema${n}.comline`);
  if (!name) return;
  const f: SchemaFile = { id: nextId(), name: uniqueName(name), doc: "", state: makeState("", ctx) };
  files.push(f);
  switchTo(f.id);
  scheduleRefresh();
}

function renameFile(id: string) {
  const f = files.find((x) => x.id === id)!;
  const name = promptName("rename file", f.name);
  if (!name || name === f.name) return;
  f.name = uniqueName(name, f.id);
  if (f.id === activeId) activeNameEl.textContent = f.name;
  renderFiles();
  forceLinting(view);
  scheduleRefresh();
}

function removeFile(id: string) {
  if (files.length <= 1) return;
  const idx = files.findIndex((f) => f.id === id);
  const wasActive = id === activeId;
  files.splice(idx, 1);
  if (wasActive) switchTo(files[Math.min(idx, files.length - 1)].id);
  else renderFiles();
  scheduleRefresh();
}

function renderFiles() {
  filesEl.replaceChildren();
  for (const f of files) {
    const chip = document.createElement("button");
    chip.className = "file-chip" + (f.id === activeId ? " active" : "");
    const label = document.createElement("span");
    label.textContent = f.name;
    chip.appendChild(label);
    chip.addEventListener("click", () => switchTo(f.id));
    chip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      renameFile(f.id);
    });
    if (files.length > 1) {
      const x = document.createElement("span");
      x.className = "file-x";
      x.textContent = "×";
      x.title = "delete file";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(f.id);
      });
      chip.appendChild(x);
    }
    filesEl.appendChild(chip);
  }
  const add = document.createElement("button");
  add.className = "file-add";
  add.textContent = "+";
  add.title = "add schema file";
  add.addEventListener("click", addFile);
  filesEl.appendChild(add);
}

// ── panels ─────────────────────────────────────────────────────────────
function renderView() {
  if (currentView === "problems") renderProblems();
  else if (currentView === "ir") renderIr();
  else void renderOutput();
}

function renderProblems() {
  const reports = lastProject?.files ?? [];
  const units = reports.reduce((n, f) => n + f.units, 0);
  const rows = reports.flatMap((f) => f.diagnostics.map((d) => ({ file: f.path, d })));

  if (rows.length === 0) {
    viewEl.innerHTML = `<p class="ok">no problems — ${units} unit${
      units === 1 ? "" : "s"
    } across ${files.length} file${files.length === 1 ? "" : "s"}</p>`;
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "diagnostics";
  for (const { file, d } of rows) {
    const li = document.createElement("li");
    const loc = document.createElement("span");
    loc.className = "loc";
    loc.textContent = `${file}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
    li.appendChild(loc);
    li.appendChild(document.createTextNode(" " + d.message));
    li.addEventListener("click", () => jumpTo(file, d.range.start));
    ul.appendChild(li);
  }
  viewEl.replaceChildren(ul);
}

function renderIr() {
  const rep = lastProject?.files.find((f) => f.path === activeFile().name);
  const head = `<div class="file-name">${escapeHtml(activeFile().name)}</div>`;
  viewEl.innerHTML = rep?.ir
    ? head + `<pre class="code">${escapeHtml(rep.ir)}</pre>`
    : head + `<p class="muted">file does not parse</p>`;
}

async function renderOutput() {
  viewEl.innerHTML = `<p class="muted">generating…</p>`;
  const res = await unwrap<GenerateResult>(
    { cmd: "generateProject", files: project(), target: targetSel.value, mode },
    { files: [], error: "wasm error" },
  );
  if (currentView !== "output") return;
  if (res.error) {
    viewEl.innerHTML = `<p class="err">${escapeHtml(res.error)}</p>`;
    return;
  }
  if (res.files.length === 0) {
    viewEl.innerHTML = `<p class="muted">nothing generated</p>`;
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

// ── compile loop ───────────────────────────────────────────────────────
let debounce: number | undefined;
function scheduleRefresh() {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void refresh(), 200);
}

async function refresh() {
  lastProject = await bridge.compileProject(project());
  let problems = 0;
  let parseFail = false;
  for (const f of lastProject.files) {
    problems += f.diagnostics.length;
    if (f.ir === null) parseFail = true;
  }
  statusEl.textContent = parseFail
    ? "syntax error"
    : problems === 0
      ? "ok"
      : `${problems} problem${problems === 1 ? "" : "s"}`;
  statusEl.className = `status ${problems === 0 && !parseFail ? "ok" : "err"}`;
  renderView();
}

// ── wiring ─────────────────────────────────────────────────────────────
tabsEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  for (const b of tabsEl.querySelectorAll("button")) b.classList.remove("active");
  btn.classList.add("active");
  currentView = btn.dataset.view as View;
  renderView();
});

modeEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  mode = btn.dataset.mode as "code" | "lib";
  for (const b of modeEl.querySelectorAll("button")) b.classList.toggle("active", b === btn);
  if (currentView === "output") void renderOutput();
});

targetSel.addEventListener("change", () => {
  if (currentView === "output") void renderOutput();
});

// ── boot ───────────────────────────────────────────────────────────────
for (const s of SAMPLE_FILES) {
  files.push({ id: nextId(), name: s.name, doc: s.doc, state: makeState(s.doc, ctx) });
}
activeId = files[0].id;
view = mountEditor(editorEl, files[0].state);
activeNameEl.textContent = files[0].name;
renderFiles();

statusEl.textContent = "compiling…";
void refresh();

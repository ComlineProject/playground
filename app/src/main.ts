import { StreamLanguage } from "@codemirror/language";
import { forceLinting } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  makeState,
  mountEditor,
  readOnlyExtensions,
  type EditorBridge,
  type EditorContext,
} from "./editor.ts";
import type {
  CompileProjectResult,
  CompletionItem,
  FileInput,
  GeneratedFile,
  GenerateResult,
  Hover,
  LspPosition,
  SemanticTokens,
} from "./worker.ts";
import { createSim, type ProjectShape, type SimView } from "./sim/index.ts";
import initSimWasm from "comline-simulator";
import simWasmUrl from "comline-simulator/pkg/comline_simulator_bg.wasm?url";
import examplesData from "comline-examples";

// ── examples ────────────────────────────────────────────────────────────
// `.ids` projects from ComlineProject/examples (a git dependency; bundled to
// one JSON in its `prepare`). The first is what a fresh visit opens.
interface Example {
  id: string;
  title: string;
  blurb: string;
  entry: string;
  files: { name: string; source: string }[];
}
const EXAMPLES = examplesData as Example[];

// ── virtual file set ────────────────────────────────────────────────────
interface SchemaFile {
  id: string;
  name: string;
  doc: string; // kept in sync with `state` while the file is active
  state: EditorState;
}

let files: SchemaFile[] = [];
let openIds: string[] = []; // files with an editor tab, in tab order
let activeId = "";
let uid = 0;
const nextId = () => `f${++uid}`;

const activeFile = () => files.find((f) => f.id === activeId)!;
const project = (): FileInput[] => files.map((f) => ({ path: f.name, source: f.doc }));

// cleared when an example is loaded, set on the first edit — gates the
// "replace your schema?" confirm in the Examples picker.
let dirty = false;

/** Replace the whole file set with an example's files. */
function setFiles(ex: Example) {
  files = ex.files.map((f) => ({
    id: nextId(),
    name: f.name,
    doc: f.source,
    state: makeState(f.source, ctx),
  }));
  openIds = files.map((f) => f.id);
  activeId = (files.find((f) => f.name === ex.entry) ?? files[0]).id;
  dirty = false;
}

// ── DOM ─────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $<HTMLSpanElement>("#status");
const viewEl = $<HTMLDivElement>("#view");
const tabsEl = $<HTMLDivElement>("#tabs");
const modeEl = $<HTMLDivElement>("#mode");
const targetSel = $<HTMLSelectElement>("#target");
const tabbarEl = $<HTMLDivElement>("#tabbar");
const treeEl = $<HTMLDivElement>("#tree");
const treeAddEl = $<HTMLButtonElement>("#tree-add");
const editorEl = $<HTMLDivElement>("#editor");
const editorEmptyEl = $<HTMLDivElement>("#editor-empty");
const problemsEl = $<HTMLDivElement>("#problems");
const problemsCountEl = $<HTMLSpanElement>("#problems-count");

type View = "ir" | "output";
let currentView: View = "ir";
let mode: "code" | "lib" = "code";
let lastProject: CompileProjectResult | null = null;

const fileCollapsed = new Set<string>();
let genFiles: GeneratedFile[] | null = null;
let genActivePath: string | null = null;
const genCollapsed = new Set<string>(); // collapsed folders inside the gen tree
let genPanelCollapsed = false; // the whole gen tree panel

// The generated-code viewer: one persistent read-only editor, its grammar
// swapped in through a Compartment as lazy `@codemirror/lang-*` chunks resolve.
let genView: EditorView | null = null;
let genShownKey = "";
let genRev = 0; // bumped each regenerate, so re-selecting the same file repaints
const langCompartment = new Compartment();
const langCache = new Map<string, Extension | null>();
const langLoading = new Set<string>();

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
  activeName: () => activeFile()?.name ?? "",
  onDocChanged: (d) => {
    const f = activeFile();
    if (!f) return; // the blank scratch buffer shown when no file is open
    f.doc = d;
    dirty = true;
    scheduleRefresh();
  },
};

let view!: EditorView; // assigned in boot, before any handler can fire

function activate(id: string) {
  if (id === activeId) return;
  const cur = files.find((f) => f.id === activeId);
  if (cur) cur.state = view.state;
  activeId = id;
  view.setState(activeFile().state);
  editorEl.classList.remove("is-hidden");
  editorEmptyEl.classList.add("is-hidden");
  renderTabs();
  renderFileTree();
  if (currentView === "ir") renderView();
  forceLinting(view);
}

function openFile(id: string) {
  if (!openIds.includes(id)) openIds.push(id);
  activate(id);
  renderTabs(); // in case `activate` early-returned on an already-active file
}

function closeTab(id: string) {
  const i = openIds.indexOf(id);
  if (i < 0) return;
  if (id === activeId) activeFile().state = view.state; // keep edits for a reopen
  openIds.splice(i, 1);
  if (id !== activeId) {
    renderTabs();
  } else if (openIds.length > 0) {
    activeId = "";
    activate(openIds[Math.min(i, openIds.length - 1)]);
  } else {
    showNoFile();
  }
}

/// No open tab: hide the editor behind a placeholder that points at the tree.
/// The last-shown buffer stays mounted but hidden; the next `activate`
/// replaces it.
function showNoFile() {
  activeId = "";
  editorEl.classList.add("is-hidden");
  editorEmptyEl.classList.remove("is-hidden");
  renderTabs();
  renderFileTree();
  if (currentView === "ir") renderView();
}

function jumpTo(fileName: string, pos: LspPosition) {
  const f = files.find((x) => x.name === fileName);
  if (!f) return;
  openFile(f.id);
  const { doc } = view.state;
  const line = doc.line(Math.min(pos.line + 1, doc.lines));
  view.dispatch({
    selection: { anchor: Math.min(line.from + pos.character, line.to) },
    scrollIntoView: true,
  });
  view.focus();
}

// ── files: add / rename / delete ───────────────────────────────────────
function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
function extName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : ".ids";
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
  let name = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!name) return "";
  if (!/\.[^./]+$/.test(name)) name += ".ids";
  return name;
}

function defaultName(): string {
  let n = files.length + 1;
  while (files.some((f) => f.name === `schema${n}.ids`)) n++;
  return `schema${n}.ids`;
}

function addFile() {
  const name = promptName("new schema file", defaultName());
  if (!name) return;
  const f: SchemaFile = { id: nextId(), name: uniqueName(name), doc: "", state: makeState("", ctx) };
  files.push(f);
  openIds.push(f.id);
  activate(f.id);
  scheduleRefresh();
}

function renameFile(id: string) {
  const f = files.find((x) => x.id === id)!;
  const name = promptName("rename file", f.name);
  if (!name || name === f.name) return;
  f.name = uniqueName(name, f.id);
  renderTabs();
  renderFileTree();
  forceLinting(view);
  scheduleRefresh();
}

function deleteFile(id: string) {
  if (files.length <= 1) return;
  const wasActive = id === activeId;
  files = files.filter((f) => f.id !== id);
  const oi = openIds.indexOf(id);
  if (oi >= 0) openIds.splice(oi, 1);
  if (wasActive) {
    activeId = "";
    let nextId = openIds[Math.min(Math.max(oi, 0), openIds.length - 1)];
    if (!nextId) {
      nextId = files[0].id;
      openIds.unshift(nextId);
    }
    activate(nextId);
  } else {
    renderTabs();
    renderFileTree();
  }
  scheduleRefresh();
}

// ── tab bar ────────────────────────────────────────────────────────────
function renderTabs() {
  tabbarEl.replaceChildren();
  for (const id of openIds) {
    const f = files.find((x) => x.id === id);
    if (!f) continue;
    const tab = document.createElement("div");
    tab.className = "tab" + (id === activeId ? " active" : "");
    const label = document.createElement("span");
    label.textContent = f.name;
    tab.append(label);
    tab.addEventListener("click", () => activate(id));
    tab.addEventListener("dblclick", (e) => {
      e.preventDefault();
      renameFile(id);
    });
    const x = document.createElement("span");
    x.className = "tab-x";
    x.textContent = "×";
    x.title = "close";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    tab.append(x);
    tabbarEl.append(tab);
  }
}

// ── hierarchical tree (files + generated output) ───────────────────────
interface Leaf<T> {
  name: string;
  full: string;
  data: T;
}
interface TreeDir<T> {
  name: string;
  full: string;
  dirs: TreeDir<T>[];
  files: Leaf<T>[];
}

function buildTree<T>(items: { path: string; data: T }[]): TreeDir<T> {
  const root: TreeDir<T> = { name: "", full: "", dirs: [], files: [] };
  for (const { path, data } of items) {
    const parts = path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const full = dir.full ? `${dir.full}/${seg}` : seg;
      let next = dir.dirs.find((d) => d.name === seg);
      if (!next) {
        next = { name: seg, full, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push({ name: parts[parts.length - 1], full: path, data });
  }
  const sort = (d: TreeDir<T>) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.name.localeCompare(b.name));
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

interface TreeOpts<T> {
  collapsed: Set<string>;
  isActive: (l: Leaf<T>) => boolean;
  onPick: (l: Leaf<T>) => void;
  onToggle: (full: string) => void;
  onRename?: (l: Leaf<T>) => void;
  onDelete?: (l: Leaf<T>) => void;
}

function renderTreeInto<T>(host: HTMLElement, root: TreeDir<T>, o: TreeOpts<T>) {
  const indent = (depth: number) => `${0.4 + depth * 0.85}rem`;
  const build = (dir: TreeDir<T>, depth: number): DocumentFragment => {
    const frag = document.createDocumentFragment();
    for (const d of dir.dirs) {
      const open = !o.collapsed.has(d.full);
      const row = document.createElement("div");
      row.className = "tree-row dir";
      row.style.paddingLeft = indent(depth);
      const caret = document.createElement("span");
      caret.className = "tree-caret";
      caret.textContent = open ? "▾" : "▸";
      const name = document.createElement("span");
      name.textContent = d.name;
      row.append(caret, name);
      row.addEventListener("click", () => o.onToggle(d.full));
      frag.append(row);
      if (open) frag.append(build(d, depth + 1));
    }
    for (const leaf of dir.files) {
      const row = document.createElement("div");
      row.className = "tree-row" + (o.isActive(leaf) ? " active" : "");
      row.style.paddingLeft = indent(depth);
      const spacer = document.createElement("span");
      spacer.className = "tree-spacer";
      const name = document.createElement("span");
      name.textContent = leaf.name;
      row.append(spacer, name);
      if (o.onDelete) {
        const x = document.createElement("span");
        x.className = "tree-x";
        x.textContent = "×";
        x.title = "delete";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          o.onDelete!(leaf);
        });
        row.append(x);
      }
      row.addEventListener("click", () => o.onPick(leaf));
      if (o.onRename)
        row.addEventListener("dblclick", (e) => {
          e.preventDefault();
          o.onRename!(leaf);
        });
      frag.append(row);
    }
    return frag;
  };
  host.replaceChildren(build(root, 0));
}

function toggle(set: Set<string>, key: string) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

function renderFileTree() {
  renderTreeInto(treeEl, buildTree(files.map((f) => ({ path: f.name, data: f }))), {
    collapsed: fileCollapsed,
    isActive: (l) => l.data.id === activeId,
    onPick: (l) => openFile(l.data.id),
    onToggle: (full) => {
      toggle(fileCollapsed, full);
      renderFileTree();
    },
    onRename: (l) => renameFile(l.data.id),
    onDelete: files.length > 1 ? (l) => deleteFile(l.data.id) : undefined,
  });
}

// ── panels ─────────────────────────────────────────────────────────────
function renderView() {
  viewEl.classList.toggle("split", currentView === "output");
  if (currentView === "ir") {
    destroyGenCode();
    renderIr();
  } else void renderOutput();
}

// The problems panel sits under the file tree — always shown, not a tab.
function renderProblems() {
  const reports = lastProject?.files ?? [];
  const rows = reports.flatMap((f) => f.diagnostics.map((d) => ({ file: f.path, d })));
  problemsCountEl.textContent = rows.length ? String(rows.length) : "";

  if (rows.length === 0) {
    const units = reports.reduce((n, f) => n + f.units, 0);
    problemsEl.innerHTML = `<p class="muted pad">no problems — ${units} unit${
      units === 1 ? "" : "s"
    } across ${files.length} schema${files.length === 1 ? "" : "s"}</p>`;
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
  problemsEl.replaceChildren(ul);
}

function renderIr() {
  const f = activeFile();
  if (!f) {
    viewEl.innerHTML = `<p class="muted">no file open</p>`;
    return;
  }
  const rep = lastProject?.files.find((r) => r.path === f.name);
  const head = `<div class="file-name">${escapeHtml(f.name)}</div>`;
  viewEl.innerHTML = rep?.ir
    ? head + `<pre class="code">${escapeHtml(rep.ir)}</pre>`
    : head + `<p class="muted">file does not parse</p>`;
}

async function renderOutput() {
  if (!genFiles) {
    destroyGenCode();
    viewEl.innerHTML = `<p class="muted">generating…</p>`;
  }
  const res = await unwrap<GenerateResult>(
    { cmd: "generateProject", files: project(), target: targetSel.value, mode },
    { files: [], error: "wasm error" },
  );
  if (currentView !== "output") return;
  if (res.error) {
    genFiles = null;
    destroyGenCode();
    viewEl.classList.remove("split");
    viewEl.innerHTML = `<p class="err">${escapeHtml(res.error)}</p>`;
    return;
  }
  if (res.files.length === 0) {
    genFiles = null;
    destroyGenCode();
    viewEl.classList.remove("split");
    viewEl.innerHTML = `<p class="muted">nothing generated</p>`;
    return;
  }
  genFiles = res.files;
  genRev++;
  if (!genActivePath || !genFiles.some((f) => f.path === genActivePath)) {
    genActivePath = genFiles[0].path;
  }
  paintOutput();
}

// ── generated-code grammar loading ────────────────────────────────────────
function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : "";
}

async function loadLang(ext: string): Promise<Extension | null> {
  switch (ext) {
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "js":
    case "jsx":
    case "mjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "toml": {
      const mod = await import("@codemirror/legacy-modes/mode/toml");
      return StreamLanguage.define(mod.toml);
    }
    default:
      return null;
  }
}

/// The grammar for `path`'s extension, or `null` until its lazy chunk resolves
/// — the first miss kicks off the import and repaints when it lands.
function langFor(path: string): Extension | null {
  const ext = extOf(path);
  if (langCache.has(ext)) return langCache.get(ext) ?? null;
  if (!langLoading.has(ext)) {
    langLoading.add(ext);
    void loadLang(ext).then((lang) => {
      langCache.set(ext, lang);
      langLoading.delete(ext);
      if (currentView === "output" && genActivePath && extOf(genActivePath) === ext) showGenCode();
    });
  }
  return null;
}

function paintOutput() {
  if (!genFiles) return;
  viewEl.classList.add("split");

  // The code pane + its editor persist across repaints; only the tree rebuilds.
  if (!viewEl.querySelector(".gen-view") || !genView) {
    destroyGenCode();
    const codePane = document.createElement("div");
    codePane.className = "gen-view";
    viewEl.replaceChildren(codePane);
    genView = new EditorView({ parent: codePane });
  }
  const existing = viewEl.querySelector(".tree-panel");
  if (existing) existing.replaceWith(buildGenPanel());
  else viewEl.append(buildGenPanel());

  showGenCode();
}

/// The tree panel at the bottom of the generated pane (mirrors the schema tree).
function buildGenPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "tree-panel" + (genPanelCollapsed ? " collapsed" : "");
  const head = document.createElement("div");
  head.className = "tree-head";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "tree-toggle";
  toggleBtn.setAttribute("aria-expanded", String(!genPanelCollapsed));
  const caret = document.createElement("span");
  caret.className = "tree-caret";
  caret.textContent = genPanelCollapsed ? "▸" : "▾";
  const title = document.createElement("span");
  title.textContent = "generated";
  toggleBtn.append(caret, title);
  toggleBtn.addEventListener("click", () => {
    genPanelCollapsed = !genPanelCollapsed;
    paintOutput();
  });
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = genActivePath ?? "";
  head.append(toggleBtn, path);

  const tree = document.createElement("div");
  tree.className = "gen-tree";
  renderTreeInto(tree, buildTree((genFiles ?? []).map((f) => ({ path: f.path, data: f }))), {
    collapsed: genCollapsed,
    isActive: (l) => l.full === genActivePath,
    onPick: (l) => {
      genActivePath = l.full;
      paintOutput();
    },
    onToggle: (full) => {
      toggle(genCollapsed, full);
      paintOutput();
    },
  });
  panel.append(head, tree);
  return panel;
}

/// Push the active generated file into the persistent editor. Same file (only
/// the grammar changed) → reconfigure the language compartment in place, so
/// scroll position survives a lazy grammar landing.
function showGenCode() {
  if (!genView || !genFiles) return;
  const contents = genFiles.find((f) => f.path === genActivePath)?.contents ?? "";
  const lang = langFor(genActivePath ?? "");
  const key = (genActivePath ?? "") + "@" + genRev;
  if (key === genShownKey) {
    genView.dispatch({ effects: langCompartment.reconfigure(lang ?? []) });
    return;
  }
  genShownKey = key;
  genView.setState(
    EditorState.create({
      doc: contents,
      extensions: [...readOnlyExtensions(), langCompartment.of(lang ?? [])],
    }),
  );
}

function destroyGenCode() {
  genView?.destroy();
  genView = null;
  genShownKey = "";
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
  renderProblems();
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
  genFiles = null;
  if (currentView === "output") void renderOutput();
});

targetSel.addEventListener("change", () => {
  genFiles = null;
  if (currentView === "output") void renderOutput();
});

treeAddEl.addEventListener("click", addFile);

// ── simulate view ──────────────────────────────────────────────────────
const appModeEl = $<HTMLDivElement>("#app-mode");
const simEl = $<HTMLDivElement>("#sim");
let sim: SimView | null = null;

let simLoaded = false;

async function enterSimulate() {
  await initSimWasm({ module_or_path: simWasmUrl }); // idempotent
  const shape = await unwrap<ProjectShape>(
    { cmd: "describeProject", files: project() },
    { schemas: [] },
  );
  if (!sim) {
    sim = createSim();
    simEl.append(sim.el);
  }
  // A `#s=…` fragment restores a shared topology, but only on the first entry.
  const shared = /[#&]s=([^&]+)/.exec(location.hash)?.[1];
  sim.setShape(shape, !simLoaded && shared ? decodeURIComponent(shared) : null);
  simLoaded = true;
  document.body.classList.add("mode-simulate");
}

appModeEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  for (const b of appModeEl.querySelectorAll("button")) b.classList.toggle("active", b === btn);
  if (btn.dataset.app === "simulate") void enterSimulate();
  else document.body.classList.remove("mode-simulate");
});

// Collapse / expand a static bottom panel (files, problems) by its toggle.
function wireCollapse(toggleSel: string) {
  const btn = $<HTMLButtonElement>(toggleSel);
  const panel = btn.closest(".tree-panel") as HTMLElement;
  const caret = btn.querySelector(".tree-caret") as HTMLElement;
  btn.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    btn.setAttribute("aria-expanded", String(!collapsed));
    caret.textContent = collapsed ? "▸" : "▾";
  });
}
wireCollapse("#files-toggle");
wireCollapse("#problems-toggle");

// ── examples picker ────────────────────────────────────────────────────
const examplesEl = $<HTMLSelectElement>("#examples");
for (const ex of EXAMPLES) {
  const o = document.createElement("option");
  o.value = ex.id;
  o.textContent = ex.title;
  o.title = ex.blurb;
  examplesEl.append(o);
}
examplesEl.addEventListener("change", () => {
  const ex = EXAMPLES.find((e) => e.id === examplesEl.value);
  examplesEl.value = "";
  if (!ex) return;
  if (dirty && !window.confirm(`Replace the current schema with the "${ex.title}" example?`)) return;
  setFiles(ex);
  view.setState(activeFile().state);
  editorEl.classList.remove("is-hidden");
  editorEmptyEl.classList.add("is-hidden");
  renderTabs();
  renderFileTree();
  statusEl.textContent = "compiling…";
  void refresh();
});

// ── boot ───────────────────────────────────────────────────────────────
setFiles(EXAMPLES[0]);
view = mountEditor(editorEl, activeFile().state);
renderTabs();
renderFileTree();

statusEl.textContent = "compiling…";
void refresh();

// A shared link (`…#s=…`) lands straight in the simulate view.
if (/[#&]s=/.test(location.hash)) {
  for (const b of appModeEl.querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.app === "simulate");
  }
  void enterSimulate();
}

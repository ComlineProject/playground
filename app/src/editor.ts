/// CodeMirror 6 wiring. Highlighting, diagnostics, hover and autocomplete are
/// all fed from the Comline language server (via the WASM worker), so the
/// editor matches `comline-lsp`.
///
/// The playground holds a *set* of schema files. Highlighting, hover and
/// autocomplete run against the active buffer; diagnostics come from compiling
/// the whole set as one package, so cross-file `use` resolves — the linter
/// keeps only the rows the language server attributed to the active file.

import {
  autocompletion,
  completionKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { linter, lintKeymap, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import type {
  CompileProjectResult,
  CompletionItem,
  FileInput,
  Hover,
  LspPosition,
  SemanticTokens,
} from "./worker.ts";

export interface EditorBridge {
  compileProject(files: FileInput[]): Promise<CompileProjectResult>;
  semanticTokens(src: string): Promise<SemanticTokens>;
  hover(files: FileInput[], activePath: string, line: number, character: number): Promise<Hover | null>;
  completions(src: string, line: number, character: number): Promise<CompletionItem[]>;
}

/// What the editor needs from the app besides the bridge: a live snapshot of
/// every file (the active one included) and the active file's name, so the
/// linter can compile the package and pick out this file's rows.
export interface EditorContext {
  bridge: EditorBridge;
  project: () => FileInput[];
  activeName: () => string;
  onDocChanged: (doc: string) => void;
}

// legend order — matches `comline-language-server`'s semantic_tokens
const TOKEN_CLASS = ["tok-kw", "tok-type", "tok-str", "tok-comment", "tok-num", "tok-ann"];

function posOf(doc: EditorState["doc"], p: LspPosition): number {
  const line = doc.line(Math.min(p.line + 1, doc.lines));
  return Math.min(line.from + p.character, line.to);
}

// ── semantic-token decorations ────────────────────────────────────────────
// Async-derived decorations. The StateField maps the existing set through every
// edit (so the colours shift *with* the text instead of vanishing and
// reappearing), and a ViewPlugin recomputes it ~120 ms after the last change.
const setTokens = StateEffect.define<DecorationSet>();

const tokenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setTokens)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function decodeTokens(data: number[], doc: EditorState["doc"]): Range<Decoration>[] {
  const marks: Range<Decoration>[] = [];
  let line = 0;
  let ch = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [dLine, dStart, len, type] = data.slice(i, i + 5);
    line += dLine;
    ch = dLine === 0 ? ch + dStart : dStart;
    const cls = TOKEN_CLASS[type];
    if (!cls || line >= doc.lines) continue;
    const from = doc.line(line + 1).from + ch;
    const to = Math.min(from + len, doc.length);
    if (to > from) marks.push(Decoration.mark({ class: `cm-${cls}` }).range(from, to));
  }
  return marks;
}

function semanticHighlight(bridge: EditorBridge): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: number | undefined;

      constructor(view: EditorView) {
        this.schedule(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(u.view);
      }
      destroy() {
        window.clearTimeout(this.timer);
      }
      private schedule(view: EditorView) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.run(view), 120);
      }
      private async run(view: EditorView) {
        const src = view.state.doc.toString();
        const st = await bridge.semanticTokens(src);
        if (view.state.doc.toString() !== src) return; // stale — a newer run is queued
        view.dispatch({
          effects: setTokens.of(Decoration.set(decodeTokens(st.data, view.state.doc), true)),
        });
      }
    },
  );
  return [tokenField, plugin];
}

// ── diagnostics ───────────────────────────────────────────────────────────
// Compile the whole package, keep the rows the server pinned to this file.
function diagnostics(ctx: EditorContext) {
  return linter(
    async (view): Promise<CmDiagnostic[]> => {
      const res = await ctx.bridge.compileProject(ctx.project());
      const mine = res.files.find((f) => f.path === ctx.activeName());
      const { doc } = view.state;
      return (mine?.diagnostics ?? []).map((d) => ({
        from: posOf(doc, d.range.start),
        to: Math.max(posOf(doc, d.range.end), posOf(doc, d.range.start) + 1),
        severity: d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "error",
        message: d.message,
        source: d.source ?? "comline",
      }));
    },
    { delay: 250 },
  );
}

// ── autocomplete ──────────────────────────────────────────────────────────
function comlineCompletions(bridge: EditorBridge): CompletionSource {
  return async (cx) => {
    const word = cx.matchBefore(/[\w]*/);
    if (!cx.explicit && (!word || word.from === word.to)) return null;
    const l = cx.state.doc.lineAt(cx.pos);
    const items = await bridge.completions(cx.state.doc.toString(), l.number - 1, cx.pos - l.from);
    if (items.length === 0) return null;
    return {
      from: word ? word.from : cx.pos,
      options: items.map((i) => ({
        label: i.label,
        detail: i.detail,
        type: cmCompletionType(i.kind),
        apply: i.insertTextFormat === 2 ? i.label : (i.insertText ?? i.label),
      })),
    };
  };
}

function cmCompletionType(kind?: number): string {
  // a slice of LSP CompletionItemKind
  switch (kind) {
    case 14:
      return "keyword";
    case 7:
    case 22:
      return "class";
    case 13:
      return "enum";
    case 8:
      return "interface";
    case 6:
      return "variable";
    case 5:
      return "property";
    default:
      return "text";
  }
}

// ── hover ─────────────────────────────────────────────────────────────────
// `Hover.contents` is an array of logical blocks: one `{language, value}`
// code block (the signature, syntax-colored below) plus plain-string prose
// blocks (a docstring, and/or a `*N fields*`-style detail caption). Each
// renders as its own element so CSS can divide them (`.cm-hover > * + *`).

// Line-start byte offsets for a plain string, standing in for what
// `EditorState["doc"].line()` gives `decodeTokens` for a live document —
// the signature text here is never part of one.
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

// Same delta-token decoding as `decodeTokens`, against a plain string's own
// line starts instead of a CodeMirror document, building colored `<span>`s
// (the exact `cm-tok-*` classes `theme` already defines) instead of
// `Decoration`s.
function highlightSignature(text: string, data: number[]): DocumentFragment {
  const starts = lineStarts(text);
  const frag = document.createDocumentFragment();
  let pos = 0;
  let line = 0;
  let ch = 0;
  const flushTextTo = (to: number) => {
    if (to > pos) frag.appendChild(document.createTextNode(text.slice(pos, to)));
  };
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [dLine, dStart, len, type] = data.slice(i, i + 5);
    line += dLine;
    ch = dLine === 0 ? ch + dStart : dStart;
    const cls = TOKEN_CLASS[type];
    const from = (starts[line] ?? text.length) + ch;
    const to = Math.min(from + len, text.length);
    if (!cls || to <= from || from < pos) continue;
    flushTextTo(from);
    const span = document.createElement("span");
    span.className = `cm-${cls}`;
    span.textContent = text.slice(from, to);
    frag.appendChild(span);
    pos = to;
  }
  flushTextTo(text.length);
  return frag;
}

const DETAIL_RE = /^\*(.+)\*$/s;

async function renderHoverBlocks(contents: unknown, bridge: EditorBridge): Promise<HTMLElement[]> {
  const items = Array.isArray(contents) ? contents : [contents];
  const blocks: HTMLElement[] = [];
  for (const c of items) {
    if (c && typeof c === "object" && "value" in c) {
      const value = String((c as { value: unknown }).value);
      const pre = document.createElement("pre");
      pre.className = "cm-hover-code";
      try {
        const tokens = await bridge.semanticTokens(value);
        pre.appendChild(highlightSignature(value, tokens.data));
      } catch {
        pre.textContent = value; // highlighting is a nicety — fall back to plain text
      }
      blocks.push(pre);
    } else if (typeof c === "string" && c) {
      const div = document.createElement("div");
      const detail = c.match(DETAIL_RE);
      div.className = detail ? "cm-hover-detail" : "cm-hover-prose";
      div.textContent = detail ? detail[1] : c;
      blocks.push(div);
    }
  }
  return blocks;
}

function hoverInfo(ctx: EditorContext) {
  return hoverTooltip(async (view, pos) => {
    // Anchor the tooltip to the whole word so it stays put while the pointer
    // moves *within* the symbol — otherwise CM re-queries on every move and
    // the tooltip flickers.
    const word = view.state.wordAt(pos);
    if (!word) return null;
    const l = view.state.doc.lineAt(pos);
    const h = await ctx.bridge.hover(ctx.project(), ctx.activeName(), l.number - 1, pos - l.from);
    if (!h) return null;
    const blocks = await renderHoverBlocks(h.contents, ctx.bridge);
    if (blocks.length === 0) return null;
    return {
      pos: word.from,
      end: word.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-hover";
        for (const block of blocks) dom.appendChild(block);
        return { dom };
      },
    };
  });
}

// ── theme ─────────────────────────────────────────────────────────────────
const theme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "0.85rem", backgroundColor: "var(--bg)", color: "var(--fg)" },
    ".cm-scroller": {
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
      lineHeight: "1.55",
    },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none" },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff08" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#3d59a1" },
    ".cm-cursor": { borderLeftColor: "var(--fg)" },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-2)",
      border: "1px solid var(--border)",
      color: "var(--fg)",
    },
    ".cm-hover": { padding: "0.4rem 0.6rem", maxWidth: "40rem" },
    ".cm-hover > * + *": {
      marginTop: "0.5rem",
      paddingTop: "0.5rem",
      borderTop: "1px solid var(--border)",
    },
    ".cm-hover-code": {
      margin: 0,
      whiteSpace: "pre-wrap",
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
    },
    ".cm-hover-prose": { whiteSpace: "pre-wrap" },
    ".cm-hover-detail": {
      whiteSpace: "pre-wrap",
      color: "var(--muted)",
      fontStyle: "italic",
      fontSize: "0.85em",
    },
    ".cm-tok-kw": { color: "#bb9af7" },
    ".cm-tok-type": { color: "#7dcfff" },
    ".cm-tok-str": { color: "#9ece6a" },
    ".cm-tok-comment": { color: "#565f89", fontStyle: "italic" },
    ".cm-tok-ann": { color: "#e0af68" },
    ".cm-tok-num": { color: "#ff9e64" },
  },
  { dark: true },
);

// ── generated-code viewer ────────────────────────────────────────────────
// One grammar-agnostic highlight style (Lezer tags → the schema editor's
// palette), shared by every generated language.
const generatedHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.definitionKeyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: "#bb9af7" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#9ece6a" },
  { tag: [t.comment], color: "#565f89", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#ff9e64" },
  { tag: [t.typeName, t.className, t.namespace], color: "#7dcfff" },
  { tag: [t.propertyName, t.attributeName], color: "#7aa2f7" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#7aa2f7" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: "#9aa5ce" },
  { tag: [t.meta], color: "#e0af68" },
  { tag: [t.self], color: "#f7768e" },
  { tag: [t.variableName], color: "#e4e4ef" },
  { tag: [t.invalid], color: "#f7768e" },
]);

const readOnlyTheme = EditorView.theme({
  "&": { fontSize: "0.8rem" },
  ".cm-scroller": { padding: "0.5rem 0" },
  ".cm-content": { caretColor: "transparent" },
});

/// Extensions for the read-only generated-code pane. Reuses the schema
/// editor's theme; the caller adds the language grammar through a Compartment.
export function readOnlyExtensions(): Extension[] {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    drawSelection(),
    theme,
    readOnlyTheme,
    syntaxHighlighting(generatedHighlightStyle),
  ];
}

/// One file's editor state — its own document and undo history. The playground
/// swaps these into the single [`EditorView`] as the user switches files.
export function makeState(doc: string, ctx: EditorContext): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      bracketMatching(),
      EditorState.tabSize.of(4),
      indentUnit.of("    "),
      theme,
      semanticHighlight(ctx.bridge),
      diagnostics(ctx),
      autocompletion({ override: [comlineCompletions(ctx.bridge)] }),
      hoverInfo(ctx),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) ctx.onDocChanged(u.state.doc.toString());
      }),
    ],
  });
}

export function mountEditor(parent: HTMLElement, state: EditorState): EditorView {
  return new EditorView({ parent, state });
}

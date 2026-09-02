/// CodeMirror 6 wiring. Highlighting, diagnostics, hover and autocomplete are
/// all fed from the Comline language server (via the WASM worker), so the
/// editor matches `comline-lsp`.

import {
  autocompletion,
  completionKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
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
  CompileResult,
  CompletionItem,
  Hover,
  LspPosition,
  SemanticTokens,
} from "./worker.ts";

export interface EditorBridge {
  compile(src: string): Promise<CompileResult>;
  semanticTokens(src: string): Promise<SemanticTokens>;
  hover(src: string, line: number, character: number): Promise<Hover | null>;
  completions(src: string, line: number, character: number): Promise<CompletionItem[]>;
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
function diagnostics(bridge: EditorBridge) {
  return linter(
    async (view): Promise<CmDiagnostic[]> => {
      const { doc } = view.state;
      const res = await bridge.compile(doc.toString());
      return res.diagnostics.map((d) => ({
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
  return async (ctx) => {
    const word = ctx.matchBefore(/[\w]*/);
    if (!ctx.explicit && (!word || word.from === word.to)) return null;
    const l = ctx.state.doc.lineAt(ctx.pos);
    const items = await bridge.completions(ctx.state.doc.toString(), l.number - 1, ctx.pos - l.from);
    if (items.length === 0) return null;
    return {
      from: word ? word.from : ctx.pos,
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
function renderHover(contents: unknown): string {
  const parts: string[] = [];
  const push = (c: unknown) => {
    if (typeof c === "string") parts.push(c);
    else if (c && typeof c === "object" && "value" in c) parts.push(String((c as { value: unknown }).value));
  };
  if (Array.isArray(contents)) contents.forEach(push);
  else push(contents);
  return parts.join("\n\n").replace(/^\*(.+)\*$/gm, "$1");
}

function hoverInfo(bridge: EditorBridge) {
  return hoverTooltip(async (view, pos) => {
    // Anchor the tooltip to the whole word so it stays put while the pointer
    // moves *within* the symbol — otherwise CM re-queries on every move and
    // the tooltip flickers.
    const word = view.state.wordAt(pos);
    if (!word) return null;
    const l = view.state.doc.lineAt(pos);
    const h = await bridge.hover(view.state.doc.toString(), l.number - 1, pos - l.from);
    if (!h) return null;
    const text = renderHover(h.contents);
    if (!text) return null;
    return {
      pos: word.from,
      end: word.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-hover";
        dom.textContent = text;
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
    ".cm-hover": { padding: "0.4rem 0.6rem", whiteSpace: "pre-wrap", maxWidth: "40rem" },
    ".cm-tok-kw": { color: "#bb9af7" },
    ".cm-tok-type": { color: "#7dcfff" },
    ".cm-tok-str": { color: "#9ece6a" },
    ".cm-tok-comment": { color: "#565f89", fontStyle: "italic" },
    ".cm-tok-ann": { color: "#e0af68" },
    ".cm-tok-num": { color: "#ff9e64" },
  },
  { dark: true },
);

export function createEditor(
  parent: HTMLElement,
  doc: string,
  bridge: EditorBridge,
  onDocChanged: (doc: string) => void,
): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
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
        semanticHighlight(bridge),
        diagnostics(bridge),
        autocompletion({ override: [comlineCompletions(bridge)] }),
        hoverInfo(bridge),
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onDocChanged(u.state.doc.toString());
        }),
      ],
    }),
  });
}

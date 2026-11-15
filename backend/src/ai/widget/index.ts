/**
 * Obelisk MCP App views (MCP Apps / SEP-1865, also what ChatGPT Apps use).
 *
 * Hosts that support MCP Apps (Claude, ChatGPT) render a tool's result in a
 * sandboxed iframe when the tool's `_meta.ui.resourceUri` points at a `ui://`
 * HTML resource. All views share one self-contained page (widget.css +
 * widget.js, no network access); each view URI just tells the page which
 * layout to use, so hosts can describe and cache them separately.
 *
 * URIs carry a content hash. Hosts cache UI resources by URI, so a deploy that
 * changes the page gets fresh URIs automatically; the resource template keeps
 * old URIs working for clients that cached an earlier tools/list.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';

export const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

export const WIDGET_VIEWS = ['tasks', 'task', 'impact', 'bottlenecks', 'projects'] as const;
export type WidgetView = (typeof WIDGET_VIEWS)[number];

const DESCRIPTION: Record<WidgetView, { title: string; model: string }> = {
  tasks: {
    title: 'Obelisk task list',
    model:
      'Shows the user summary numbers (today, overdue, upcoming, slipping) and the tasks grouped by day, most important first. The user can tick tasks done in it. Do not repeat the numbers or the list; reply in 1–2 sentences with the one thing to do first or a risk.',
  },
  task: {
    title: 'Obelisk task',
    model:
      'Shows one task to the user as a card with its status, priority, project, dates, notes and dependencies. Do not restate those fields; comment only on what matters.',
  },
  impact: {
    title: 'Obelisk delay impact',
    model:
      'Shows the delay impact to the user as a timeline: which tasks move and by how much, which fixed dates conflict, and project finish dates. After a simulation the user can apply the postponement from the card. Do not repeat the table; explain the trade-off briefly.',
  },
  bottlenecks: {
    title: 'Obelisk bottlenecks',
    model:
      'Shows the ranked bottleneck tasks with downstream counts, slack and one-day-slip cost. Do not repeat the ranking; point out what to protect.',
  },
  projects: {
    title: 'Obelisk projects',
    model: 'Shows the projects with open/overdue counts and planned finish dates. Do not repeat the list.',
  },
};

// Production reads the page once; development re-reads it so edits show up without a restart
// (bun --watch only tracks imported modules) and get a fresh URI, so hosts drop their cache.
const live = process.env.NODE_ENV !== 'production';
let assets: { css: string; js: string; version: string; html: Map<WidgetView, string> } | undefined;

function load() {
  if (assets && !live) return assets;
  const css = readFileSync(join(import.meta.dir, 'widget.css'), 'utf8');
  const js = readFileSync(join(import.meta.dir, 'widget.js'), 'utf8');
  const version = createHash('sha256').update(css).update(js).digest('hex').slice(0, 10);
  if (!assets || assets.version !== version) assets = { css, js, version, html: new Map() };
  return assets;
}

export function widgetVersion(): string {
  return load().version;
}

export function widgetUri(view: WidgetView): string {
  return `ui://obelisk/${widgetVersion()}/${view}.html`;
}

/** Inline JSON safely inside a <script> element. */
const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export function isWidgetView(v: unknown): v is WidgetView {
  return typeof v === 'string' && (WIDGET_VIEWS as readonly string[]).includes(v);
}

export function widgetHtml(view: WidgetView): string {
  const a = load();
  let html = a.html.get(view);
  if (!html) a.html.set(view, (html = buildHtml(view, a)));
  return html;
}

function buildHtml(view: WidgetView, { css, js, version }: { css: string; js: string; version: string }): string {
  const boot = { view, base: config.publicUrl, version };
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${DESCRIPTION[view].title}</title>
<style>${css}</style>
</head>
<body>
<div id="root" class="root" aria-live="polite"></div>
<script>window.__OBELISK__=${scriptJson(boot)};</script>
<script>${js}</script>
</body>
</html>`;
}

/** `_meta` for the resource (MCP Apps keys + ChatGPT's legacy aliases). */
export function widgetResourceMeta(view: WidgetView) {
  return {
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
    'openai/widgetDescription': DESCRIPTION[view].model,
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
  };
}

/** `_meta` for a tool that renders `view`. */
export function widgetToolMeta(view: WidgetView, status: { invoking: string; invoked: string }) {
  const uri = widgetUri(view);
  return {
    ui: { resourceUri: uri },
    'ui/resourceUri': uri,
    'openai/outputTemplate': uri,
    'openai/widgetAccessible': true,
    'openai/toolInvocation/invoking': status.invoking,
    'openai/toolInvocation/invoked': status.invoked,
  };
}

export function widgetTitle(view: WidgetView) {
  return DESCRIPTION[view].title;
}

/** Did the client say it renders MCP Apps (initialize → capabilities.extensions)? */
export function clientSupportsUi(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined)?.extensions?.[
    UI_EXTENSION_ID
  ];
  if (!ext) return false;
  return !Array.isArray(ext.mimeTypes) || ext.mimeTypes.includes(UI_MIME_TYPE);
}

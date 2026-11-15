/*
 * Obelisk MCP App view. Vanilla JS, no dependencies, no network access.
 *
 * Talks to the host over the MCP Apps postMessage bridge (JSON-RPC 2.0):
 *   view → host  ui/initialize, ui/notifications/initialized, ui/notifications/size-changed,
 *                tools/call, ui/open-link, ui/update-model-context
 *   host → view  ui/notifications/tool-input, ui/notifications/tool-result,
 *                ui/notifications/host-context-changed, ui/resource-teardown, ping
 * ChatGPT also exposes window.openai; it is used only as a fallback.
 */
(() => {
  'use strict';

  const CFG = window.__OBELISK__ || {};
  const BASE = String(CFG.base || '').replace(/\/+$/, '');
  const root = document.getElementById('root');

  const S = {
    data: null,
    dataKey: '',
    error: null,
    cancelled: false,
    input: {},
    toolName: null,
    notice: null,
    noticeTimer: 0,
    busy: new Set(),
    open: new Set(),
    pop: new Set(),
    ctxLog: [],
    applying: null,
  };

  // ───────────────────────────── bridge

  const host = { ready: false, caps: {}, ctx: {} };
  const pending = new Map();
  let seq = 0;

  const post = (msg) => {
    try {
      window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, msg), '*');
    } catch (_) {
      /* not embedded */
    }
  };

  function rpc(method, params, timeout = 60000) {
    const id = ++seq;
    post({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error('응답이 없어요'));
      }, timeout);
      pending.set(id, { resolve, reject, t });
    });
  }

  const notify = (method, params) => post({ method, params: params || {} });

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    const hasId = Object.prototype.hasOwnProperty.call(m, 'id') && m.id !== null;
    if (hasId && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.t);
      if (m.error) p.reject(new Error(m.error.message || '오류가 났어요'));
      else p.resolve(m.result);
      return;
    }
    const reply = (result) => hasId && post({ id: m.id, result });
    switch (m.method) {
      case 'ui/notifications/tool-input':
        S.input = (m.params && m.params.arguments) || {};
        break;
      case 'ui/notifications/tool-result':
        receive(m.params);
        break;
      case 'ui/notifications/tool-cancelled':
        S.cancelled = true;
        render();
        break;
      case 'ui/notifications/host-context-changed':
        applyContext(m.params || {});
        render();
        break;
      case 'ui/resource-teardown':
      case 'ping':
        reply({});
        break;
      default:
        if (hasId) post({ id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  rpc(
    'ui/initialize',
    {
      appInfo: { name: 'obelisk', version: String(CFG.version || '1') },
      appCapabilities: { availableDisplayModes: ['inline'] },
      protocolVersion: '2026-01-26',
    },
    15000,
  )
    .then((r) => {
      host.ready = true;
      host.caps = (r && r.hostCapabilities) || {};
      applyContext((r && r.hostContext) || {});
      notify('ui/notifications/initialized');
      render();
    })
    .catch(() => {})
    .finally(watchSize);

  const OA = () => window.openai;

  function fromOpenAI() {
    const o = OA();
    if (!o) return;
    if (o.theme) applyTheme(o.theme);
    if (o.toolInput) S.input = o.toolInput;
    if (o.toolOutput && !S.data) receive({ structuredContent: o.toolOutput });
  }

  window.addEventListener('openai:set_globals', (e) => {
    const g = (e && e.detail && e.detail.globals) || {};
    if (g.theme) applyTheme(g.theme);
    if (g.toolOutput) receive({ structuredContent: g.toolOutput });
  });

  function applyTheme(t) {
    if (t !== 'dark' && t !== 'light') return;
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  }

  function applyContext(c) {
    host.ctx = Object.assign({}, host.ctx, c);
    if (c.theme) applyTheme(c.theme);
    const vars = c.styles && c.styles.variables;
    if (vars) for (const k of Object.keys(vars)) if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
    const fonts = c.styles && c.styles.css && c.styles.css.fonts;
    if (fonts && !document.getElementById('host-fonts')) {
      const st = document.createElement('style');
      st.id = 'host-fonts';
      st.textContent = fonts;
      document.head.appendChild(st);
    }
    if (c.toolInfo && c.toolInfo.tool && c.toolInfo.tool.name) S.toolName = c.toolInfo.tool.name;
  }

  function watchSize() {
    if (watchSize.on) return;
    watchSize.on = true;
    let last = 0;
    let queued = false;
    const measure = () => {
      if (queued) return;
      queued = true;
      // rAF never fires while the host keeps the frame hidden/off-screen; the timer covers that.
      let done = false;
      const run = (fn) => () => {
        if (done) return;
        done = true;
        fn();
      };
      const frame = run(() => {
        queued = false;
        const el = document.documentElement;
        const prev = el.style.height;
        el.style.height = 'max-content';
        const height = Math.ceil(el.getBoundingClientRect().height);
        el.style.height = prev;
        if (height === last) return;
        last = height;
        notify('ui/notifications/size-changed', { height });
        try {
          const o = OA();
          if (o && typeof o.notifyIntrinsicHeight === 'function') o.notifyIntrinsicHeight(height);
        } catch (_) {
          /* optional */
        }
      });
      requestAnimationFrame(frame);
      setTimeout(frame, 120);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    ro.observe(document.body);
    watchSize.measure = measure;
  }

  const textOf = (res) =>
    ((res && res.content) || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('\n');

  function receive(res) {
    if (!res) return;
    if (res.isError) {
      S.error = textOf(res) || '요청을 처리하지 못했어요.';
      S.data = null;
      render();
      return;
    }
    let sc = res.structuredContent;
    if (!sc) {
      try {
        sc = JSON.parse(textOf(res));
      } catch (_) {
        return;
      }
    }
    if (!sc || typeof sc !== 'object') return;
    const key = JSON.stringify(sc);
    if (key === S.dataKey) return;
    S.dataKey = key;
    S.data = JSON.parse(key);
    S.error = null;
    S.cancelled = false;
    render();
  }

  // ───────────────────────────── host actions

  const canCall = () => (host.ready ? !!host.caps.serverTools : !!(OA() && typeof OA().callTool === 'function'));
  const canOpen = () => !!BASE && (host.ready ? !!host.caps.openLinks : !!(OA() && typeof OA().openExternal === 'function'));

  async function callTool(name, args) {
    if (host.ready && host.caps.serverTools) return rpc('tools/call', { name, arguments: args });
    const o = OA();
    if (o && typeof o.callTool === 'function') return o.callTool(name, args);
    throw new Error('이 앱에서는 카드에서 바로 바꿀 수 없어요');
  }

  function openLink(url) {
    if (host.ready && host.caps.openLinks) {
      rpc('ui/open-link', { url }).catch(() => {});
      return;
    }
    const o = OA();
    if (o && typeof o.openExternal === 'function') o.openExternal({ href: url });
  }

  function tellModel(line) {
    S.ctxLog = S.ctxLog.concat(line).slice(-12);
    const text =
      'Changes the user made directly in the Obelisk card (already saved in Obelisk):\n' +
      S.ctxLog.map((l) => `- ${l}`).join('\n');
    if (host.ready && host.caps.updateModelContext) {
      rpc('ui/update-model-context', { content: [{ type: 'text', text }] }).catch(() => {});
      return;
    }
    const o = OA();
    if (o && typeof o.setWidgetState === 'function') {
      try {
        o.setWidgetState({ modelContent: text });
      } catch (_) {
        /* optional */
      }
    }
  }

  function flash(text, tone = 'ok') {
    S.notice = { text, tone };
    clearTimeout(S.noticeTimer);
    S.noticeTimer = setTimeout(() => {
      S.notice = null;
      render();
    }, 4500);
  }

  // ───────────────────────────── DOM helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    add(el, kids);
    return el;
  }

  function add(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false || k === '') continue;
      if (Array.isArray(k)) add(el, k);
      else el.append(k instanceof Node ? k : String(k));
    }
  }

  const P = {
    calendar: 'M4 9h16M8 3v3M16 3v3M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z',
    sun: 'M12 4V2.5M12 21.5V20M4 12H2.5M21.5 12H20M6.3 6.3 5.2 5.2M18.8 18.8l-1.1-1.1M6.3 17.7l-1.1 1.1M18.8 5.2l-1.1 1.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    inbox: 'M3 13h5l1.5 2.5h5L16 13h5M5.5 5h13l2.5 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z',
    list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
    layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5',
    folder: 'M3 7a1 1 0 0 1 1-1h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
    alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    alertCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 8v4M12 16h.01',
    check: 'm5 12.5 4.5 4.5L19 7.5',
    checkCircle: 'M8.5 12.5 11 15l4.5-5.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    chevronDown: 'm6 9.5 6 6 6-6',
    chevronRight: 'm9.5 6 6 6-6 6',
    arrowRight: 'M5 12h14M13 6l6 6-6 6',
    circleDashed:
      'M12 3a9 9 0 0 1 4.5 1.2M20.8 10.5a9 9 0 0 1-.6 5.1M16.5 19.8A9 9 0 0 1 12 21M7.5 19.8a9 9 0 0 1-3.3-3.3M3.2 10.5A9 9 0 0 1 7.5 4.2',
    target:
      'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    ripple: 'M3 12h3l2.5-6 4 12 3-9 1.5 3H21',
    postpone: 'M12 8v4l2.5 2.5M3.5 12a8.5 8.5 0 1 0 2.5-6M3 3.5V8h4.5',
    plus: 'M12 5v14M5 12h14',
    pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
    undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    xCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15 9l-6 6M9 9l6 6',
    notes: 'M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM9 8h6M9 12h6M9 16h3',
    play: 'M8 5.5v13l10-6.5-10-6.5Z',
  };

  const svg = (inner, size, vb = 24, sw = 1.75) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const icon = (name, size = 14, sw) => h('span', { class: 'ic', html: svg(`<path d="${P[name]}"/>`, size, 24, sw) });

  const LOGO =
    '<svg width="SIZE" height="SIZE" viewBox="0 0 510.01 512" fill="currentColor" aria-hidden="true"><path d="M379.97,288c-3.03,11.74-7.68,22.83-13.7,33.02l91.96,91.95c27.52-35.41,45.95-78.23,51.78-124.97H379.97Z"/><path d="M321.02,366.27c-19.06,11.26-41.28,17.73-65.02,17.73-70.69,0-128-57.31-128-128,0-23.74,6.47-45.96,17.73-65.02L53.77,99.03C20.08,142.38,0,196.84,0,256c0,141.38,114.62,256,256,256,59.16,0,113.62-20.08,156.97-53.77L321.02,366.27Z"/><path d="M190.98,145.73c19.06-11.26,41.28-17.73,65.02-17.73,59.64,0,109.76,40.79,123.97,96h130.04C494.26,97.72,386.55,0,256,0c-59.16,0-113.62,20.08-156.97,53.77L190.98,145.73Z"/></svg>';
  const logo = (size = 14) => h('span', { class: 'ic', html: LOGO.replace(/SIZE/g, String(size)) });

  function statusSvg(s, size = 14) {
    const ring = '<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" fill="none"/>';
    let inner = ring;
    if (s === 'doing') inner = ring + '<path d="M8 4.25a3.75 3.75 0 0 1 0 7.5Z" fill="currentColor"/>';
    if (s === 'done')
      inner =
        '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5.1 8.25 1.95 1.9 3.85-4.1" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
    if (s === 'canceled')
      inner =
        '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>';
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;
  }

  function prioSvg(p, size = 16) {
    if (!p || p === 'none') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><g fill="currentColor" opacity=".6"><rect x="1.5" y="7.25" width="3" height="1.5" rx=".75"/><rect x="6.5" y="7.25" width="3" height="1.5" rx=".75"/><rect x="11.5" y="7.25" width="3" height="1.5" rx=".75"/></g></svg>`;
    }
    const n = { low: 1, medium: 2, high: 3 }[p] || 0;
    const bars = [
      [1.5, 9, 5],
      [6.5, 6, 8],
      [11.5, 3, 11],
    ]
      .map(
        ([x, y, hh], i) =>
          `<rect x="${x}" y="${y}" width="3" height="${hh}" rx="1" fill="currentColor" opacity="${i < n ? 1 : 0.22}"/>`,
      )
      .join('');
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${bars}</svg>`;
  }

  const KIND_ICON = { overdue: 'alertCircle', root: 'postpone', shifted: 'arrowRight', conflict: 'lock', absorbed: 'check', unscheduled: 'circleDashed' };

  // ───────────────────────────── labels

  const STATUS_KO = { todo: '할 일', doing: '진행 중', done: '완료', canceled: '취소' };
  const PRIO_KO = { none: '우선순위 없음', low: '낮음', medium: '보통', high: '높음' };
  const VIEW = {
    today: { title: '오늘', icon: 'sun', link: '/today' },
    upcoming: { title: '예정', icon: 'calendar', link: '/upcoming' },
    overdue: { title: '기한 지남', icon: 'alertCircle', tone: 'danger', link: '/today' },
    inbox: { title: '인박스', icon: 'inbox', link: '/inbox' },
    unscheduled: { title: '날짜 없음', icon: 'circleDashed', link: '/all' },
    all: { title: '모든 작업', icon: 'list', link: '/all' },
    done: { title: '완료한 작업', icon: 'checkCircle', link: '/logbook' },
  };

  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const dayN = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5);
  const fromDayN = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const ddiff = (a, b) => dayN(a) - dayN(b);
  const wdOf = (iso) => WD[new Date(dayN(iso) * 864e5).getUTCDay()];
  const md = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
  const mdW = (iso) => `${md(iso)} (${wdOf(iso)})`;
  const longDate = (iso) => `${+iso.slice(5, 7)}월 ${+iso.slice(8, 10)}일 ${wdOf(iso)}요일`;
  const daysKo = (n) => {
    const a = Math.abs(n);
    return a >= 7 && a % 7 === 0 ? `${a / 7}주` : `${a}일`;
  };

  function rel(iso, today) {
    if (!today) return mdW(iso);
    const d = ddiff(iso, today);
    if (d === 0) return '오늘';
    if (d === 1) return '내일';
    if (d === 2) return '모레';
    if (d === -1) return '어제';
    if (d > 2 && d < 7) return `${wdOf(iso)}요일`;
    if (iso.slice(0, 4) === today.slice(0, 4)) return `${+iso.slice(5, 7)}월 ${+iso.slice(8, 10)}일`;
    return `${iso.slice(0, 4)}.${+iso.slice(5, 7)}.${+iso.slice(8, 10)}`;
  }

  const spanOf = (s) => {
    if (!s) return null;
    const [a, b] = String(s).split('..');
    return [dayN(a), dayN(b || a)];
  };

  const spanText = (s) => {
    if (!s) return '날짜 없음';
    const [a, b] = String(s).split('..');
    return !b || a === b ? mdW(a) : `${md(a)} – ${md(b)}`;
  };

  const isActive = (t) => t.status === 'todo' || t.status === 'doing';

  // ───────────────────────────── shared pieces

  function header({ ic, tone, title, sub, right }) {
    return h(
      'div',
      { class: 'hd' },
      h('span', { class: 'hd-icon', 'data-tone': tone }, ic),
      h('div', { class: 'hd-text' }, h('span', { class: 'hd-title' }, title), sub ? h('span', { class: 'hd-sub' }, sub) : null),
      right && right.length ? h('div', { class: 'hd-right' }, right) : null,
    );
  }

  function footer(link, extra) {
    const n = S.notice;
    return h(
      'div',
      { class: 'ft' },
      n
        ? h('span', { class: 'ft-note', 'data-tone': n.tone }, icon(n.tone === 'danger' ? 'alertCircle' : 'checkCircle', 14), n.text)
        : h('span', { class: 'ft-brand' }, logo(13), 'Obelisk'),
      h(
        'div',
        { class: 'ft-right' },
        extra,
        link && canOpen()
          ? h('button', { class: 'btn ghost', onclick: () => openLink(BASE + link) }, 'Obelisk에서 열기', icon('external', 13))
          : null,
      ),
    );
  }

  const stat = (label, value, tone) =>
    h('span', { class: 'pill-stat', 'data-tone': tone }, label, h('b', { class: 'num' }, value));

  function chip(text, opts = {}) {
    return h(
      'span',
      { class: 'chip', 'data-tone': opts.tone, 'data-kind': opts.kind, title: opts.title },
      opts.dot ? h('span', { class: 'dot', style: `--c: var(--p-${opts.dot})` }) : null,
      opts.ic || null,
      h('span', { class: 'label' }, text),
    );
  }

  const projectChip = (t) => chip(t.project, { kind: 'project', dot: t.projectColor || 'slate' });

  /** Project as quiet text; lists show it only when they mix projects. */
  const projectTag = (t) =>
    h('span', { class: 'proj', title: t.project }, h('span', { class: 'dot', style: `--c: var(--p-${t.projectColor || 'slate'})` }), t.project);

  const mixesProjects = (tasks) => new Set(tasks.map((t) => t.project || '')).size > 1;

  const PRIO_RANK = { high: 3, medium: 2, low: 1, none: 0 };
  const refNum = (t) => Number(String(t.ref).replace(/\D/g, '')) || 0;
  const firstDay = (t) => t.startDate || t.dueDate || null;

  /** Priority first, then in progress, then the earlier deadline (same rule as the server). */
  function byImportance(a, b) {
    const day = (t) => t.dueDate || t.startDate || '9999-12-31';
    return (
      (PRIO_RANK[b.priority] || 0) - (PRIO_RANK[a.priority] || 0) ||
      (b.status === 'doing') - (a.status === 'doing') ||
      day(a).localeCompare(day(b)) ||
      refNum(a) - refNum(b)
    );
  }

  /**
   * Day groups: 기한 지남 → 오늘 → 내일 / 요일 (next 6 days) → 나중에 → 날짜 없음 → 완료,
   * most important first inside each. A task sits where it needs attention: overdue by its
   * deadline, "today" once it has started or is in progress, otherwise on the day it starts.
   */
  function dayGroups(tasks, today) {
    const out = new Map();
    const put = (key, meta, t) => {
      if (!out.has(key)) out.set(key, Object.assign({ key, tasks: [] }, meta));
      out.get(key).tasks.push(t);
    };
    for (const t of tasks) {
      const first = firstDay(t);
      if (!isActive(t)) put('done', { order: 1e6, label: '완료' }, t);
      else if (today && t.dueDate && t.dueDate < today) put('overdue', { order: -2, label: '기한 지남', tone: 'danger' }, t);
      else if (!first) put('none', { order: 1e5 + 1, label: '날짜 없음' }, t);
      else if (!today || t.status === 'doing' || first <= today) put('today', { order: -1, label: '오늘' }, t);
      else {
        const n = ddiff(first, today);
        if (n <= 6) put(first, { order: n, label: n === 1 ? '내일' : `${wdOf(first)}요일`, sub: md(first) }, t);
        else put('later', { order: 1e5, label: '나중에', sub: '7일 이후' }, t);
      }
    }
    const groups = [...out.values()].sort((x, y) => x.order - y.order);
    for (const g of groups) if (g.key !== 'done') g.tasks.sort(byImportance);
    return groups;
  }

  /** Date for a row. Inside a day group the header already names the day, so rows say less. */
  function dateEl(t, today, group) {
    const s = t.startDate;
    const d = t.dueDate;
    if (!s && !d) return null;
    const range = s && d && s !== d;
    const exact = range ? `${mdW(s)} – ${mdW(d)}` : mdW(d || s);
    let label = null;
    let tone = null;
    if (isActive(t) && today && d && d < today) {
      const n = ddiff(today, d);
      label = n === 1 ? '어제 마감' : `${n}일 지남`;
      tone = 'overdue';
    } else if (group === 'today' && today) {
      if (d === today) {
        label = '오늘 마감';
        tone = 'today';
      } else if (d && (!s || s <= today)) label = `${rel(d, today)}까지`;
      else if (range) label = `${md(s)} – ${md(d)}`;
      else if (s && s > today) label = `${rel(s, today)} 시작`;
    } else if (group && group !== 'later' && group !== 'done' && group !== 'none') {
      label = range ? `~${md(d)}` : null;
    } else {
      label = range
        ? today && s <= today && d >= today
          ? `${rel(d, today)}까지`
          : `${md(s)} – ${md(d)}`
        : rel(d || s, today) + (d ? '' : ' 시작');
      if (isActive(t) && today && ((d || s) === today || (range && s <= today && d >= today))) tone = 'today';
    }
    return label ? h('span', { class: 'date', 'data-tone': tone, title: exact }, label) : null;
  }

  function flags(t) {
    const out = [];
    if (t.fixed) out.push(h('span', { class: 'ic', title: '고정 일정 — 움직이지 않아요' }, icon('lock', 12)));
    if ((t.postponedCount || 0) >= 3)
      out.push(h('span', { class: 'flag-postponed', title: `${t.postponedCount}번 미룬 작업` }, icon('postpone', 11), t.postponedCount));
    return out.length ? h('span', { class: 'flags' }, out) : null;
  }

  function statusEl(t, size = 14) {
    const pop = S.pop.has(t.ref);
    const busy = S.busy.has(t.ref);
    const attrs = {
      class: 'status',
      'data-s': t.status,
      'data-p': t.priority,
      'data-pop': pop || null,
      'data-busy': busy || null,
      html: statusSvg(t.status, size),
    };
    const what = `${STATUS_KO[t.status]} · ${PRIO_KO[t.priority] || ''}`;
    if (!canCall() || t.status === 'canceled') return h('span', Object.assign(attrs, { title: what }));
    const done = t.status === 'done';
    return h(
      'button',
      Object.assign(attrs, {
        type: 'button',
        title: `${what} — ${done ? '다시 열기' : '완료로 표시'}`,
        'aria-label': `${t.ref} ${done ? '다시 열기' : '완료로 표시'}`,
        onclick: (e) => {
          e.stopPropagation();
          toggleDone(t);
        },
      }),
    );
  }

  function linkProps(path) {
    if (!canOpen() || !path) return {};
    const go = () => openLink(BASE + path);
    return {
      'data-link': '',
      role: 'link',
      tabindex: 0,
      title: 'Obelisk에서 열기',
      onclick: go,
      onkeydown: (e) => {
        if (e.key === 'Enter') go();
      },
    };
  }

  /** One task: ring (status, coloured by priority) · #ref · title · flags · [project] · date. */
  function taskRow(t, today, opts = {}) {
    return h(
      'div',
      Object.assign({ class: 'row', 'data-s': t.status, 'data-p': t.priority }, t.id ? linkProps(`/t/${t.id}`) : {}),
      statusEl(t),
      h('span', { class: 'ref' }, t.ref),
      h('span', { class: 'title' }, t.title),
      flags(t),
      h(
        'span',
        { class: 'meta' },
        opts.after ? h('span', { class: 'after' }, opts.after) : null,
        t.project && opts.showProject ? projectTag(t) : null,
        opts.noDate ? null : dateEl(t, today, opts.group),
      ),
    );
  }

  function moreButton(key, hidden) {
    return h(
      'button',
      {
        class: 'more',
        type: 'button',
        onclick: () => {
          S.open.add(key);
          render();
        },
      },
      icon('chevronDown', 13),
      `${hidden}개 더 보기`,
    );
  }

  /** A day group: a quiet label line, then calm rows. */
  function group(g, today, opts = {}) {
    const tasks = g.tasks;
    if (!tasks || !tasks.length) return null;
    const limit = opts.limit || 6;
    const open = S.open.has(g.key) || tasks.length <= limit + 1;
    const shown = open ? tasks : tasks.slice(0, limit);
    return h(
      'section',
      { class: 'grp' },
      g.label
        ? h(
            'div',
            { class: 'gh', 'data-tone': g.tone },
            h('span', null, g.label),
            g.sub ? h('span', { class: 'sub num' }, g.sub) : null,
            h('span', { class: 'count num' }, tasks.length),
          )
        : null,
      h(
        'div',
        { class: 'rows calm' },
        shown.map((t) =>
          taskRow(t, today, Object.assign({ group: g.key }, opts, { after: opts.afterOf ? opts.afterOf(t) : null })),
        ),
      ),
      open ? null : moreButton(g.key, tasks.length - limit),
    );
  }

  const statusIcon = (s, p) => h('span', { class: 'status', 'data-s': s, 'data-p': p, html: statusSvg(s, 14) });

  /** Big-number tile (overview summary, impact stats). */
  const tile = (label, v, tone, text) =>
    h(
      'div',
      { class: 'stat', 'data-tone': tone, 'data-zero': v ? null : '' },
      h('div', { class: 'stat-v' }, text != null ? text : v),
      h('div', { class: 'stat-l' }, label),
    );

  function empty(title, text, tone, ic = 'checkCircle') {
    return h('div', { class: 'empty', 'data-tone': tone }, icon(ic, 18), h('b', null, title), text ? h('span', null, text) : null);
  }

  function mini(rows) {
    return h(
      'ul',
      { class: 'mini' },
      rows.map((r) =>
        h('li', null, r.ic || null, h('span', { class: 'ref' }, r.ref), h('span', { class: 't' }, r.title), h('span', { class: 'v', 'data-tone': r.tone }, r.value)),
      ),
    );
  }

  function impactMini(impacts, max = 4) {
    const list = impacts.filter((i) => i.effect === 'conflict' || i.effect === 'shifted');
    const rows = list.slice(0, max).map((i) =>
      i.effect === 'conflict'
        ? { ic: icon('lock', 12), ref: i.ref, title: i.title, value: `충돌 · ${daysKo(i.overrunDays || 0)} 초과`, tone: 'danger' }
        : { ic: icon('arrowRight', 12), ref: i.ref, title: i.title, value: `+${daysKo(i.shiftDays || 0)}`, tone: 'warn' },
    );
    if (list.length > max) rows.push({ ref: '', title: `외 ${list.length - max}개`, value: '' });
    return rows.length ? mini(rows) : null;
  }

  // ───────────────────────────── actions

  async function toggleDone(t) {
    if (S.busy.has(t.ref)) return;
    const was = Object.assign({}, t);
    const undo = t.status === 'done';
    t.status = undo ? 'todo' : 'done';
    S.busy.add(t.ref);
    if (!undo) S.pop.add(t.ref);
    render();
    try {
      const r = await callTool('complete_task', { ref: t.ref, undo });
      if (!r || r.isError) throw new Error(textOf(r) || '실패했어요');
      const next = r.structuredContent && r.structuredContent.task;
      if (next) {
        delete t.overdue;
        Object.assign(t, next);
      }
      const d = S.data;
      if (d && d.counts) d.counts.completedToday = Math.max(0, (d.counts.completedToday || 0) + (undo ? -1 : 1));
      if (d && d.action && (d.task === t || d.task.ref === t.ref)) d.action = undo ? 'reopened' : 'completed';
      const unblocked = (r.structuredContent && r.structuredContent.nowUnblocked) || [];
      if (d && d.action === 'completed' && d.task.ref === t.ref) d.nowUnblocked = unblocked;
      flash(
        undo
          ? `${t.ref} 다시 열었어요`
          : unblocked.length
            ? `${t.ref} 완료 · 이제 ${unblocked.map((u) => u.ref).join(', ')} 시작 가능`
            : `${t.ref} 완료했어요`,
      );
      tellModel(`${t.ref} "${t.title}" marked ${undo ? 'not done (reopened)' : 'done'}`);
    } catch (e) {
      Object.assign(t, was);
      flash(`바꾸지 못했어요 · ${e.message}`, 'danger');
    }
    S.busy.delete(t.ref);
    setTimeout(() => S.pop.delete(t.ref), 400);
    render();
  }

  async function applyPostpone(imp, cascade) {
    if (S.applying) return;
    S.applying = cascade ? 'all' : 'one';
    render();
    try {
      const r = await callTool('postpone_task', { ref: imp.root.ref, days: imp.root.days, cascade });
      if (!r || r.isError) throw new Error(textOf(r) || '실패했어요');
      const sc = r.structuredContent;
      if (!sc || !sc.impact) throw new Error('결과를 받지 못했어요');
      S.data = Object.assign({ today: S.data && S.data.today }, sc);
      S.dataKey = JSON.stringify(S.data);
      const moved = (sc.moved || []).length;
      flash(cascade ? `작업 ${moved}개를 옮겼어요` : `${imp.root.ref}만 옮겼어요`);
      tellModel(
        `Applied the simulated postponement: ${imp.root.ref} "${imp.root.title}" moved ${imp.root.days >= 0 ? 'later' : 'earlier'} by ${Math.abs(imp.root.days)} day(s), cascade=${cascade}, ${moved} task(s) moved`,
      );
    } catch (e) {
      flash(`적용하지 못했어요 · ${e.message}`, 'danger');
    }
    S.applying = null;
    render();
  }

  // ───────────────────────────── views: task lists

  function viewOverview(d) {
    const today = d.today;
    const seen = new Set();
    const all = []
      .concat(d.overdue || [], d.todayTasks || [], d.upcoming || [])
      .filter((t) => !seen.has(t.ref) && seen.add(t.ref));
    const groups = dayGroups(all, today);
    const size = (key) => (groups.find((g) => g.key === key) || { tasks: [] }).tasks.length;
    const upcoming = groups
      .filter((g) => !['overdue', 'today', 'none', 'done'].includes(g.key))
      .reduce((n, g) => n + g.tasks.length, 0);
    const risk =
      d.delayRisk && typeof d.delayRisk === 'object' && (d.delayRisk.delayed || d.delayRisk.conflicts) ? d.delayRisk : null;
    const slipping = risk ? (risk.delayed || 0) + (risk.conflicts || 0) : 0;
    return h(
      'div',
      null,
      header({ ic: icon('sun', 14), title: '오늘', sub: longDate(today) }),
      h(
        'div',
        { class: 'stats' },
        tile('오늘 할 일', size('today')),
        tile('기한 지남', size('overdue'), 'danger'),
        tile(`다가오는 ${d.upcomingDays || 7}일`, upcoming),
        tile('밀리는 일정', slipping, 'warn'),
      ),
      risk
        ? h(
            'div',
            { class: 'banner slim', 'data-tone': risk.conflicts ? 'danger' : 'warn' },
            icon('alert', 14),
            h('span', { class: 'banner-text' }, risk.headline),
          )
        : null,
      all.length
        ? h('div', { class: 'groups' }, groups.map((g) => group(g, today, { showProject: mixesProjects(all) })))
        : empty('오늘은 여유로워요', '예정된 작업이 없어요.', 'ok'),
      footer('/'),
    );
  }

  function viewList(d) {
    const view = d.view || S.input.view || 'all';
    const meta = VIEW[view] || VIEW.all;
    const today = d.today;
    const tasks = d.tasks || [];
    const groups = view === 'done' ? [{ key: 'done', label: '', tasks }] : dayGroups(tasks, today);
    return h(
      'div',
      null,
      header({
        ic: icon(meta.icon, 14),
        tone: meta.tone,
        title: d.project ? `${meta.title} · ${d.project}` : meta.title,
        sub: `${d.count != null ? d.count : tasks.length}개`,
      }),
      tasks.length
        ? h(
            'div',
            { class: 'groups' },
            groups.map((g) => group(g, today, { showProject: !d.project && mixesProjects(tasks), limit: 8 })),
          )
        : empty('해당하는 작업이 없어요', null, null, 'circleDashed'),
      footer(meta.link),
    );
  }

  function viewCreated(d) {
    const today = d.today;
    const after = new Map();
    for (const dep of d.dependencies || []) {
      if (!dep || typeof dep !== 'object') continue;
      after.set(dep.task, (after.get(dep.task) || []).concat(dep.blockedBy));
    }
    const projects = new Set(d.created.map((t) => t.project).filter(Boolean));
    const one = projects.size === 1 && d.created.every((t) => t.project) ? d.created[0] : null;
    return h(
      'div',
      null,
      header({
        ic: icon('plus', 14),
        tone: 'ok',
        title: `작업 ${d.created.length}개를 만들었어요`,
        sub: one ? one.project : null,
        right: after.size ? [stat('연결', (d.dependencies || []).length)] : null,
      }),
      h(
        'div',
        { class: 'groups' },
        group({ key: 'created', label: '', tasks: d.created }, today, {
          showProject: !one && mixesProjects(d.created),
          limit: 12,
          afterOf: (t) => (after.has(t.ref) ? `${after.get(t.ref).join(', ')} 다음` : null),
        }),
      ),
      footer('/'),
    );
  }

  // ───────────────────────────── view: one task

  function viewTask(d) {
    const t = d.task || d.created || d.updated;
    const today = d.today;
    const mode = d.created ? 'created' : d.updated ? 'updated' : d.action || 'view';
    const BADGE = {
      created: ['새로 만듦', 'ok', 'plus'],
      updated: ['수정됨', 'brand', 'pencil'],
      completed: ['완료함', 'brand', 'check'],
      reopened: ['다시 열림', null, 'undo'],
    };
    const badge = BADGE[mode];
    const props = [
      chip(STATUS_KO[t.status], { ic: h('span', { class: 'status', 'data-s': t.status, 'data-p': t.priority, html: statusSvg(t.status, 14) }) }),
      chip(PRIO_KO[t.priority], { ic: h('span', { class: 'ic prio', 'data-p': t.priority, html: prioSvg(t.priority, 14) }) }),
    ];
    const s = t.startDate;
    const due = t.dueDate;
    if (s && due && s !== due) props.push(chip(`${mdW(s)} – ${mdW(due)}`, { ic: icon('calendar', 13) }));
    else if (due) props.push(chip(`${rel(due, today)} 마감`, { ic: icon('calendar', 13), title: mdW(due) }));
    else if (s) props.push(chip(`${rel(s, today)} 시작`, { ic: icon('calendar', 13), title: mdW(s) }));
    if (t.overdue && due && today) props.push(chip(`${ddiff(today, due)}일 지남`, { tone: 'danger', ic: icon('alertCircle', 13) }));
    if (t.fixed) props.push(chip('고정 일정', { ic: icon('lock', 13), title: '앞 작업이 밀려도 움직이지 않아요' }));
    if (t.postponedCount) props.push(chip(`${t.postponedCount}번 미룸`, { tone: t.postponedCount >= 2 ? 'warn' : null, ic: icon('postpone', 13) }));

    const notesOpen = S.open.has('notes');
    const longNotes = t.notes && (t.notes.length > 320 || t.notes.split('\n').length > 6);

    const linkRows = (list) =>
      h(
        'div',
        { class: 'rows' },
        list.map((l) =>
          h(
            'div',
            Object.assign({ class: 'row', 'data-s': l.status }, l.id ? linkProps(`/t/${l.id}`) : {}),
            h('span', { class: 'ref' }, l.ref),
            statusIcon(l.status),
            h('span', { class: 'title' }, l.title),
            h('span', { class: 'after' }, STATUS_KO[l.status]),
          ),
        ),
      );

    const rel1 = t.blockedBy && t.blockedBy.length ? t.blockedBy : null;
    const rel2 = t.blocks && t.blocks.length ? t.blocks : null;
    const unblocked = d.action === 'completed' && d.nowUnblocked && d.nowUnblocked.length ? d.nowUnblocked : null;
    const dep = d.warning && d.dependentsAffected ? d.dependentsAffected : null;

    const active = isActive(t);
    const toggle = canCall() && t.status !== 'canceled'
      ? h(
          'button',
          {
            class: active ? 'btn primary' : 'btn',
            type: 'button',
            disabled: S.busy.has(t.ref) || null,
            onclick: () => toggleDone(t),
          },
          S.busy.has(t.ref) ? h('span', { class: 'spin' }) : icon(active ? 'check' : 'undo', 13, 2),
          active ? '완료로 표시' : '다시 열기',
        )
      : null;

    return h(
      'div',
      null,
      h(
        'div',
        { class: 'detail', 'data-s': t.status, style: 'padding-top:14px' },
        h(
          'div',
          { class: 'crumbs' },
          t.project ? h('span', { class: 'dot', style: `--c: var(--p-${t.projectColor || 'slate'})` }) : icon('inbox', 13),
          h('span', null, t.project || '인박스'),
          h('span', { class: 'sep' }, '›'),
          h('span', { class: 'num' }, t.ref),
          badge ? h('span', { class: 'badge' }, chip(badge[0], { tone: badge[1], ic: icon(badge[2], 12, 2) })) : null,
        ),
        h('h2', { class: 'detail-title' }, t.title),
        h('div', { class: 'props' }, props),
        t.notes ? h('p', { class: 'notes', 'data-open': notesOpen || !longNotes || null }, t.notes) : null,
        longNotes && !notesOpen
          ? h(
              'button',
              {
                class: 'notes-toggle',
                type: 'button',
                onclick: () => {
                  S.open.add('notes');
                  render();
                },
              },
              '메모 더 보기',
            )
          : null,
        rel1 || rel2 || unblocked
          ? h(
              'div',
              { class: 'rel' },
              rel1 ? [h('div', { class: 'rel-h' }, icon('link', 12), `선행 작업 · ${rel1.length}`), linkRows(rel1)] : null,
              rel2 ? [h('div', { class: 'rel-h' }, icon('arrowRight', 12), `후속 작업 · ${rel2.length}`), linkRows(rel2)] : null,
              unblocked ? [h('div', { class: 'rel-h' }, icon('play', 12), '이제 시작할 수 있어요'), linkRows(unblocked)] : null,
            )
          : null,
      ),
      dep
        ? h(
            'div',
            { class: 'banner', 'data-tone': dep.conflicts ? 'danger' : 'warn' },
            icon('alert', 15),
            h(
              'div',
              { class: 'banner-body' },
              h('span', { class: 'banner-title' }, '후속 작업은 그대로예요'),
              h('span', { class: 'banner-text' }, '날짜만 바꿔서 아래 작업이 이 작업보다 먼저 시작해요. 함께 옮기려면 대화에서 “후속 작업도 같이 미뤄줘”라고 말해 주세요.'),
              impactMini(dep.impacts || [], 5),
            ),
          )
        : null,
      footer(t.id ? `/t/${t.id}` : '/', toggle),
    );
  }

  // ───────────────────────────── view: delay impact

  function niceStep(total) {
    for (const s of [1, 2, 3, 7, 14, 30, 60]) if (total / s <= 6) return s;
    return 90;
  }

  function timeline(impacts, today, mode) {
    const items = impacts.map((i) => ({ i, from: spanOf(i.from), to: spanOf(i.to) }));
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items)
      for (const s of [it.from, it.to])
        if (s) {
          lo = Math.min(lo, s[0]);
          hi = Math.max(hi, s[1]);
        }
    const t0 = today ? dayN(today) : null;
    const scheduled = Number.isFinite(lo);
    if (scheduled && t0 !== null && t0 < lo && lo - t0 <= 10) lo = t0;
    if (scheduled && t0 !== null && t0 > hi && t0 - hi <= 10) hi = t0;
    lo -= 1;
    hi += 2;
    const total = Math.max(hi - lo, 1);
    const pct = (n) => ((n - lo) / total) * 100;
    const step = niceStep(total);
    const ticks = [];
    if (scheduled) for (let n = lo + 1; n < hi; n += step) if (pct(n) < 90) ticks.push(n);

    const todayLine = () =>
      scheduled && t0 !== null && t0 >= lo && t0 < hi ? h('i', { class: 'today-line', style: `left:${pct(t0)}%`, title: '오늘' }) : null;

    const TAG = {
      overdue: (i) => `오늘 끝내도 +${daysKo(i.shiftDays || 0)}`,
      root: (i) => `${(i.shiftDays || 0) >= 0 ? '+' : '−'}${daysKo(i.shiftDays || 0)}`,
      shifted: (i) => `+${daysKo(i.shiftDays || 0)}`,
      conflict: (i) => `${daysKo(i.overrunDays || 0)} 초과`,
      absorbed: (i) => `여유 ${i.slackLeftDays || 0}일`,
      unscheduled: () => '날짜 없음',
    };

    const row = ({ i, from, to }) => {
      // In a forecast the roots are overdue tasks assumed to finish today, not postponements.
      const k = mode === 'forecast' && i.effect === 'root' ? 'overdue' : i.effect;
      const now = to || from;
      const moved = from && to && (from[0] !== to[0] || from[1] !== to[1]);
      let track;
      if (!now) {
        track = h('div', { class: 'track' }, h('div', { class: 'track-empty' }, '날짜 없음 · 지연을 그대로 넘겨요'));
      } else {
        const bar = (s, cls) =>
          h('i', { class: `bar ${cls}`, 'data-k': k, style: `left:${pct(s[0])}%;width:${pct(s[1] + 1) - pct(s[0])}%` });
        const end = pct(now[1] + 1);
        const start = Math.min(pct(now[0]), moved ? pct(from[0]) : 100);
        const tagStyle = end > 76 ? `right:${100 - start}%` : `left:${end}%`;
        track = h(
          'div',
          { class: 'track' },
          todayLine(),
          moved ? bar(from, 'ghost') : null,
          bar(now, 'solid'),
          h('span', { class: 'bar-tag', 'data-k': k, style: tagStyle }, TAG[k](i)),
        );
      }
      const span = moved ? `${spanText(i.from)} → ${spanText(i.to)}` : spanText(i.from || i.to);
      return h(
        'div',
        { class: 'tl-row', title: `${i.ref} ${i.title} · ${span}${i.because && k !== 'root' ? ` · ${i.because} 때문` : ''}` },
        h(
          'div',
          { class: 'tl-label' },
          h('span', { class: 'kind', 'data-k': k }, icon(KIND_ICON[k], 11, 2.2)),
          h('span', { class: 'ref' }, i.ref),
          h('span', { class: 'title' }, i.title),
        ),
        track,
      );
    };

    const LIMIT = 10;
    const open = S.open.has('timeline') || items.length <= LIMIT + 1;
    const shown = open ? items : items.slice(0, LIMIT);
    return h(
      'div',
      { class: 'tl' },
      scheduled
        ? h(
            'div',
            { class: 'tl-axis' },
            h('div', { class: 'tl-label', style: 'font-size:11px;color:var(--text-3)' }, '작업'),
            h(
              'div',
              { class: 'track' },
              ticks.map((n) => h('span', { class: 'tick', style: `left:${pct(n)}%` }, md(fromDayN(n)))),
            ),
          )
        : null,
      shown.map(row),
      open ? null : moreButton('timeline', items.length - LIMIT),
    );
  }

  function viewImpact(d) {
    const imp = d.prediction || d.impact || d.forecast;
    const mode = d.prediction ? 'simulate' : d.impact ? 'applied' : 'forecast';
    const today = d.today;
    const rootRow = imp.root ? imp.impacts.find((i) => i.ref === imp.root.ref && i.effect === 'root') : null;
    const hit = imp.delayed || imp.conflicts;

    let hd;
    if (mode === 'simulate')
      hd = header({ ic: icon('ripple', 14), tone: 'brand', title: '지연 시뮬레이션', sub: imp.root ? `${imp.root.ref} ${imp.root.title}` : null });
    else if (mode === 'applied')
      hd = header({
        ic: icon('checkCircle', 14),
        tone: 'ok',
        title: '일정을 옮겼어요',
        sub: d.cascade === false ? '이 작업만 옮김' : `작업 ${(d.moved || []).length}개 이동`,
      });
    else
      hd = header({
        ic: icon('activity', 14),
        tone: hit ? (imp.conflicts ? 'danger' : 'warn') : 'ok',
        title: '지연 예측',
        sub: d.overdueRoots ? `기한 지난 작업 ${d.overdueRoots}개 기준` : '기한 지난 작업 없음',
      });

    const move =
      rootRow && rootRow.from && rootRow.to
        ? h(
            'div',
            { class: 'move' },
            h('span', { class: 'from num' }, spanText(rootRow.from)),
            icon('arrowRight', 13),
            h('span', { class: 'to num' }, spanText(rootRow.to)),
            chip(`${imp.root.days >= 0 ? '+' : '−'}${daysKo(imp.root.days)}`, { tone: 'brand' }),
          )
        : null;

    const statCell = (label, v, tone, text) =>
      h(
        'div',
        { class: 'stat', 'data-tone': tone, 'data-zero': v ? null : '' },
        h('div', { class: 'stat-v' }, text != null ? text : v),
        h('div', { class: 'stat-l' }, label),
      );

    const quiet = mode === 'forecast' && !d.overdueRoots;
    const slips = imp.projectSlips || [];

    let actions = null;
    if (mode === 'simulate' && imp.root && canCall()) {
      const busy = S.applying;
      const spin = h('span', { class: 'spin' });
      actions = h(
        'div',
        { class: 'actions' },
        hit
          ? [
              h(
                'button',
                { class: 'btn primary', type: 'button', disabled: !!busy || null, onclick: () => applyPostpone(imp, true) },
                busy === 'all' ? spin : icon('layers', 13),
                `모두 함께 미루기 · ${imp.delayed + 1}개`,
              ),
              h(
                'button',
                { class: 'btn', type: 'button', disabled: !!busy || null, onclick: () => applyPostpone(imp, false) },
                busy === 'one' ? spin : null,
                '이 작업만 미루기',
              ),
              h(
                'span',
                { class: 'hint' },
                imp.conflicts
                  ? '고정 일정은 움직이지 않아요. 함께 미뤄도 충돌은 남으니, 미루는 폭을 줄이거나 범위를 덜어내는 것도 방법이에요.'
                  : '함께 미루면 후속 작업이 기간을 유지한 채 같이 밀려요. 이 작업만 미루면 후속 작업이 먼저 시작하게 돼요.',
              ),
            ]
          : h(
              'button',
              { class: 'btn primary', type: 'button', disabled: !!busy || null, onclick: () => applyPostpone(imp, true) },
              busy ? spin : icon('postpone', 13),
              '미루기 적용',
            ),
      );
    }

    return h(
      'div',
      null,
      hd,
      move,
      h('p', { class: 'lead' }, imp.headline),
      quiet
        ? empty('지금 밀리고 있는 일정이 없어요', '기한을 넘긴 작업이 없어서 일정 전체가 계획대로예요.', 'ok')
        : [
            h(
              'div',
              { class: 'stats' },
              statCell('밀리는 작업', imp.delayed, 'warn'),
              statCell('고정 일정 충돌', imp.conflicts, 'danger'),
              statCell('여유로 흡수', imp.absorbed, 'ok'),
              (() => {
                const max = imp.maxDelayDays != null ? imp.maxDelayDays : imp.maxShiftDays;
                return statCell('최대 지연', max, 'warn', max ? `+${daysKo(max)}` : '—');
              })(),
            ),
            imp.impacts.length ? timeline(imp.impacts, today, mode) : null,
          ],
      slips.length
        ? [
            h('div', { class: 'section-label' }, '프로젝트 완료일'),
            h(
              'div',
              { class: 'slips', style: 'margin-top:0' },
              slips.map((p) =>
                h(
                  'div',
                  { class: 'slip' },
                  h('span', { class: 'dot', style: `--c: var(--p-${p.projectColor || 'slate'})` }),
                  h('span', { class: 'name' }, p.project),
                  h('span', { class: 'num', style: 'color:var(--text-3);text-decoration:line-through' }, mdW(p.finishFrom)),
                  h('span', { class: 'arrow' }, icon('arrowRight', 12)),
                  h('span', { class: 'num' }, mdW(p.finishTo)),
                  h('span', { class: 'v' }, chip(`+${daysKo(p.shiftDays)}`, { tone: 'warn' })),
                ),
              ),
            ),
          ]
        : null,
      actions || (slips.length ? h('div', { style: 'height:12px' }) : null),
      footer('/forecast'),
    );
  }

  // ───────────────────────────── view: bottlenecks

  function viewBottlenecks(d) {
    const list = d.bottlenecks || [];
    const today = d.today;
    const max = Math.max(1, ...list.map((b) => b.downstreamTasks || 0));
    return h(
      'div',
      null,
      header({ ic: icon('target', 14), tone: list.length ? 'danger' : null, title: '병목 작업', sub: '일정이 가장 많이 기대는 작업' }),
      list.length
        ? h(
            'div',
            { class: 'rows', style: 'border-top:1px solid var(--line-2)' },
            list.map((b, idx) => {
              const slack = b.slackDays;
              const late = b.ifOneDayLate || {};
              return h(
                'div',
                Object.assign({ class: 'row tall', 'data-s': b.status }, b.id ? linkProps(`/t/${b.id}`) : {}),
                h('span', { class: 'rank', 'data-top': idx === 0 && (late.fixedConflicts || slack === 0) ? '' : null }, idx + 1),
                h(
                  'div',
                  { class: 'stack' },
                  h(
                    'div',
                    { class: 'titleline' },
                    h('span', { class: 'ref' }, b.ref),
                    statusEl(b),
                    h('span', { class: 'title' }, b.title),
                    flags(b),
                    h('span', { class: 'meta' }, b.project && mixesProjects(list) ? projectTag(b) : null, dateEl(b, today)),
                  ),
                  h(
                    'div',
                    { class: 'sub', style: 'padding-left:42px' },
                    h(
                      'span',
                      { class: 'metric' },
                      h('span', { class: 'meter' }, h('i', { style: `width:${Math.round(((b.downstreamTasks || 0) / max) * 100)}%` })),
                      '후속',
                      h('b', null, `${b.downstreamTasks}개`),
                    ),
                    h(
                      'span',
                      { class: 'metric', 'data-tone': slack === 0 ? 'danger' : slack !== null && slack <= 2 ? 'warn' : null },
                      '여유',
                      h('b', null, slack === null ? '—' : slack === 0 ? '없음' : `${slack}일`),
                    ),
                    h(
                      'span',
                      { class: 'metric', 'data-tone': late.fixedConflicts ? 'danger' : late.delayed ? 'warn' : null },
                      '하루 늦으면',
                      late.delayed ? h('b', null, `${late.delayed}개 밀림`) : null,
                      late.delayed && late.fixedConflicts ? '·' : null,
                      late.fixedConflicts ? h('b', null, `충돌 ${late.fixedConflicts}`) : null,
                      !late.delayed && !late.fixedConflicts ? h('b', null, '영향 없음') : null,
                    ),
                  ),
                ),
              );
            }),
          )
        : empty('병목이 없어요', '다른 작업이 기다리는 작업이 없어요. 작업을 서로 연결하면 병목을 찾아드려요.', null, 'link'),
      footer('/forecast'),
    );
  }

  // ───────────────────────────── view: projects

  function viewProjects(d) {
    const list = d.projects || [];
    const today = d.today;
    return h(
      'div',
      null,
      header({ ic: icon('layers', 14), title: '프로젝트', sub: `${list.length}개` }),
      list.length
        ? h(
            'div',
            { class: 'rows', style: 'border-top:1px solid var(--line-2)' },
            list.map((p) => {
              const health = p.overdue
                ? h('span', { class: 'health', style: 'color:var(--c-red)' }, h('span', { class: 'dot', style: '--c:var(--c-red)' }), `기한 지남 ${p.overdue}`)
                : p.open
                  ? h('span', { class: 'health' }, h('span', { class: 'dot', style: '--c:var(--c-green)' }), '순조')
                  : h('span', { class: 'health' }, h('span', { class: 'dot', style: '--c:var(--c-gray)' }), '열린 작업 없음');
              return h(
                'div',
                Object.assign({ class: 'row', 'data-archived': p.archived || null }, linkProps(`/projects/${p.id}`)),
                h('span', { class: 'picon', style: `--c: var(--p-${p.color || 'slate'})` }, icon('folder', 12, 2)),
                h('span', { class: 'title', style: 'font-weight:500' }, p.name),
                p.archived ? chip('보관됨', { tone: 'quiet' }) : null,
                h(
                  'span',
                  { class: 'meta' },
                  health,
                  h('span', { class: 'metric' }, '열린 작업', h('b', null, p.open)),
                  p.plannedFinish
                    ? h('span', { class: 'date', title: `예상 완료 ${mdW(p.plannedFinish)}` }, icon('target', 12), rel(p.plannedFinish, today))
                    : h('span', { class: 'date' }, '—'),
                ),
              );
            }),
          )
        : empty('프로젝트가 없어요', null, null, 'layers'),
      footer('/'),
    );
  }

  // ───────────────────────────── states + dispatch

  function viewLoading() {
    const bar = (w) => h('div', { class: 'sk', style: `width:${w}%` });
    return h(
      'div',
      null,
      header({ ic: logo(13), title: S.cancelled ? '취소됨' : 'Obelisk', sub: S.cancelled ? '요청이 취소됐어요' : '불러오는 중…' }),
      S.cancelled ? null : h('div', { class: 'skeleton' }, bar(72), bar(54), bar(63)),
    );
  }

  function viewError(msg) {
    return h(
      'div',
      null,
      header({ ic: icon('alertCircle', 14), tone: 'danger', title: '처리하지 못했어요' }),
      h('div', { class: 'error', style: 'padding-top:0' }, h('span', null, msg || S.error)),
    );
  }

  function infer(d) {
    if (d.counts || Array.isArray(d.tasks) || Array.isArray(d.created)) return 'tasks';
    if (d.prediction || d.impact || d.forecast) return 'impact';
    if (d.task || d.created || d.updated) return 'task';
    if (Array.isArray(d.bottlenecks)) return 'bottlenecks';
    if (Array.isArray(d.projects)) return 'projects';
    return null;
  }

  function pick(d) {
    switch (infer(d) || CFG.view) {
      case 'tasks':
        return d.counts ? viewOverview(d) : Array.isArray(d.created) ? viewCreated(d) : viewList(d);
      case 'task':
        return viewTask(d);
      case 'impact':
        return viewImpact(d);
      case 'bottlenecks':
        return viewBottlenecks(d);
      case 'projects':
        return viewProjects(d);
      default:
        return viewError('표시할 수 없는 결과예요.');
    }
  }

  function render() {
    let node;
    try {
      node = S.error ? viewError() : S.data ? pick(S.data) : viewLoading();
    } catch (e) {
      console.error('[obelisk]', e);
      node = viewError('카드를 그리지 못했어요.');
    }
    root.replaceChildren(node);
    if (watchSize.measure) watchSize.measure();
  }

  render();
  fromOpenAI();
})();

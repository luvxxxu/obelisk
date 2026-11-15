import type { SVGProps } from 'react';

const PATHS = {
  inbox: 'M3 13h5l1.5 2.5h5L16 13h5M5.5 5h13l2.5 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z',
  sun: 'M12 4V2.5M12 21.5V20M4 12H2.5M21.5 12H20M6.3 6.3 5.2 5.2M18.8 18.8l-1.1-1.1M6.3 17.7l-1.1 1.1M18.8 5.2l-1.1 1.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  calendar: 'M4 9h16M8 3v3M16 3v3M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z',
  layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5',
  ripple: 'M3 12h3l2.5-6 4 12 3-9 1.5 3H21',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  checkCircle: 'M8.5 12.5 11 15l4.5-5.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.6Z',
  plus: 'M12 5v14M5 12h14',
  search: 'm20 20-4.5-4.5M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
  x: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'm9.5 6 6 6-6 6',
  chevronDown: 'm6 9.5 6 6 6-6',
  chevronLeft: 'm14.5 6-6 6 6 6',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v8',
  postpone: 'M12 8v4l2.5 2.5M3.5 12a8.5 8.5 0 1 0 2.5-6M3 3.5V8h4.5',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  // 4-point star — the old cross-with-diamond read as a "+" (add) at 15–16px
  sparkle: 'M12 3.5Q13 11 20.5 12Q13 13 12 20.5Q11 13 3.5 12Q11 11 12 3.5Z',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  key: 'M15.5 7.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM10.3 10 3 17.3V21h3.7l.8-.8V18h2.2v-2.2h2.2L14 13.7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  timeline: 'M4 6h9M8 12h10M6 18h7M4 3v18',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  hash: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z',
  play: 'M8 5.5v13l10-6.5-10-6.5Z',
  circleDashed: 'M12 3a9 9 0 0 1 4.5 1.2M20.8 10.5a9 9 0 0 1-.6 5.1M16.5 19.8A9 9 0 0 1 12 21M7.5 19.8a9 9 0 0 1-3.3-3.3M3.2 10.5A9 9 0 0 1 7.5 4.2',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  shield: 'M12 3 4.5 6v5.5c0 4.5 3.2 8.3 7.5 9.5 4.3-1.2 7.5-5 7.5-9.5V6L12 3Z',
  keyboard: 'M3 6.5h18v11H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  home: 'M15 21v-7a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v7M3 10a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z',
  panelLeft: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  monitor: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 21h8M12 17v4',
  chevronsUpDown: 'm7 15 5 5 5-5M7 9l5-5 5 5',
  chevronUp: 'm6 14.5 6-6 6 6',
  trendingUp: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6',
  trendingDown: 'M22 17l-8.5-8.5-5 5L2 7M16 17h6v-6',
  target: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  gauge: 'm12 14 4-4M3.34 19a10 10 0 1 1 17.32 0',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  barChart: 'M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3',
  arrowUpRight: 'M7 7h10v10M7 17 17 7',
  arrowLeft: 'M19 12H5M11 18l-6-6 6-6',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 16v-4M12 8h.01',
  alertCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 8v4M12 16h.01',
  xCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15 9l-6 6M9 9l6 6',
  circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  listChecks: 'm3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8',
  command: 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  calendarClock: 'M20 11V6.5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h6M4 9h16M8 3v3M16 3v3M17.5 14v3.5l2 1.5M22 17.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
  hourglass: 'M6 3h12M6 21h12M7 3v3.5a5 5 0 0 0 2.5 4.3L12 12l2.5-1.2A5 5 0 0 0 17 6.5V3M7 21v-3.5a5 5 0 0 1 2.5-4.3L12 12l2.5 1.2a5 5 0 0 1 2.5 4.3V21',
  chevronsLeft: 'm11 17-5-5 5-5M18 17l-5-5 5-5',
  chevronsRight: 'm6 17 5-5-5-5M13 17l5-5-5-5',
  fileText: 'M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5ZM14 3v5h5M9 13h6M9 17h4',
  board: 'M5 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM11 4h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM16 4h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
  table: 'M4.5 4h15a.5.5 0 0 1 .5.5v15a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5v-15a.5.5 0 0 1 .5-.5ZM4 9.5h16M4 14.75h16M9.5 9.5V20',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 16.8h.01',
  squarePen: 'M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8l-4 1 1-4 9.4-9.2Z',
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  sort: 'M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5',
  filter: 'M4 6h16M7 12h10M10 18h4',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.15a3.5 3.5 0 0 1 0 6.7',
  smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  // Source: public/obelisk.svg (inlined so it follows the theme via currentColor).
  return (
    <svg width={size} height={size} viewBox="0 0 510.01 512" fill="currentColor" aria-hidden="true">
      <path d="M379.97,288c-3.03,11.74-7.68,22.83-13.7,33.02l91.96,91.95c27.52-35.41,45.95-78.23,51.78-124.97H379.97Z" />
      <path d="M321.02,366.27c-19.06,11.26-41.28,17.73-65.02,17.73-70.69,0-128-57.31-128-128,0-23.74,6.47-45.96,17.73-65.02L53.77,99.03C20.08,142.38,0,196.84,0,256c0,141.38,114.62,256,256,256,59.16,0,113.62-20.08,156.97-53.77L321.02,366.27Z" />
      <path d="M190.98,145.73c19.06-11.26,41.28-17.73,65.02-17.73,59.64,0,109.76,40.79,123.97,96h130.04C494.26,97.72,386.55,0,256,0c-59.16,0-113.62,20.08-156.97,53.77L190.98,145.73Z" />
    </svg>
  );
}

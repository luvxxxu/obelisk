// Dev-only: React Grab — hover any element and press ⌘C / Ctrl+C to copy its
// component stack with source locations for a coding agent.
// Next runs this file before hydration; the guard keeps it out of production.
if (process.env.NODE_ENV === 'development') {
  void import('react-grab');
}

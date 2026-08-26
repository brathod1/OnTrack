import type { Config } from "tailwindcss";

/**
 * Deliberately close to Tailwind's defaults.
 *
 * This is a dense internal business tool that people use all day, not a
 * marketing site. The palette below adds only what the domain actually needs:
 * status and priority colours that must be distinguishable at a glance in a
 * table of two hundred rows.
 *
 * Note every status also carries a distinct shape or label in the UI. Colour
 * alone fails for the ~8% of men with colour vision deficiency, and fails
 * completely when someone prints a report.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        status: {
          assigned: "#64748b", // slate  — not started
          progress: "#2563eb", // blue   — in flight
          review: "#9333ea", // purple — waiting on someone else
          done: "#16a34a", // green
          cancelled: "#94a3b8", // muted
          blocked: "#ea580c", // orange — a flag, not a status
        },
        priority: {
          critical: "#dc2626",
          high: "#ea580c",
          normal: "#64748b",
          low: "#94a3b8",
        },
        overdue: "#b91c1c",
      },
      fontFamily: {
        // System stack: no webfont download, no layout shift, and it looks
        // native on the Windows machines the firm actually uses.
        sans: [
          "Segoe UI",
          "system-ui",
          "-apple-system",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["Cascadia Mono", "Consolas", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;

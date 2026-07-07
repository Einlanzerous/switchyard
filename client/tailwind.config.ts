import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";
import animate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{vue,ts,js}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        sidebar: "hsl(var(--sidebar))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },

        // v4 "Elevated" palette — theme-aware CSS vars since SWY-158 (light
        // values in style.css :root, dark in .dark). Status hues / agent /
        // pos / neg vars hold raw `R G B` triplets so alpha modifiers
        // (`border-st-planning/30`) compose; the rest are full colors, so
        // no alpha modifiers on those (none are used).
        surface: {
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          4: "var(--surface-4)",
        },
        line: {
          DEFAULT: "var(--line)",
          soft: "var(--line-soft)",
          strong: "var(--line-strong)",
        },
        ink: {
          DEFAULT: "var(--text)",
          2: "var(--text-2)",
          3: "var(--text-3)",
          4: "var(--text-4)",
        },
        // Coral brand accent ("signal light"); shadcn `accent` stays the
        // hover-surface slot, so the design doc's --accent lives here.
        // Shared across both themes (plain constants) — except signal-2,
        // the "readable coral" text tint, which flips per theme.
        signal: {
          DEFAULT: "#e2623d",
          2: "rgb(var(--signal-2) / <alpha-value>)",
          weak: "rgba(226,98,61,0.13)",
          line: "rgba(226,98,61,0.42)",
          glow: "rgba(226,98,61,0.28)",
        },
        st: {
          backlog: "rgb(var(--st-backlog) / <alpha-value>)",
          planning: "rgb(var(--st-planning) / <alpha-value>)",
          progress: "rgb(var(--st-progress) / <alpha-value>)",
          blocked: "rgb(var(--st-blocked) / <alpha-value>)",
          closed: "rgb(var(--st-closed) / <alpha-value>)",
          "backlog-bg": "var(--st-backlog-bg)",
          "planning-bg": "var(--st-planning-bg)",
          "progress-bg": "var(--st-progress-bg)",
          "blocked-bg": "var(--st-blocked-bg)",
          "closed-bg": "var(--st-closed-bg)",
        },
        agent: {
          DEFAULT: "rgb(var(--agent) / <alpha-value>)",
          bg: "var(--agent-bg)",
        },
        pos: "rgb(var(--pos) / <alpha-value>)",
        neg: "rgb(var(--neg) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Hanken Grotesk Variable", ...defaultTheme.fontFamily.sans],
        mono: ["JetBrains Mono Variable", ...defaultTheme.fontFamily.mono],
      },
      borderRadius: {
        xl: "var(--radius-lg)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config;

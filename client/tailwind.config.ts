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

        // v4 "Elevated" palette — dark-first constants (see style.css :root).
        surface: {
          1: "#101114",
          2: "#16171b",
          3: "#1c1d22",
          4: "#232429",
        },
        line: {
          DEFAULT: "#26272d",
          soft: "#1b1c21",
        },
        ink: {
          DEFAULT: "#eceded",
          2: "#a3a4aa",
          3: "#6c6d73",
          4: "#4d4e54",
        },
        // Coral brand accent ("signal light"); shadcn `accent` stays the
        // hover-surface slot, so the design doc's --accent lives here.
        signal: {
          DEFAULT: "#e2623d",
          2: "#f0855f",
          weak: "rgba(226,98,61,0.13)",
          line: "rgba(226,98,61,0.42)",
          glow: "rgba(226,98,61,0.28)",
        },
        st: {
          backlog: "#808289",
          planning: "#c08cd8",
          progress: "#64a0d6",
          blocked: "#d76f6a",
          closed: "#63b58c",
          "backlog-bg": "rgba(128,130,137,0.14)",
          "planning-bg": "rgba(192,140,216,0.15)",
          "progress-bg": "rgba(100,160,214,0.15)",
          "blocked-bg": "rgba(215,111,106,0.15)",
          "closed-bg": "rgba(99,181,140,0.15)",
        },
        agent: {
          DEFAULT: "#8fa6bd",
          bg: "rgba(143,166,189,0.14)",
        },
        pos: "#63b58c",
        neg: "#d76f6a",
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
        card: "0 1px 0 rgba(255,255,255,0.02) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // 深色為預設（:root）；亮色主題以 <html class="light"> 覆寫 CSS 變數切換（M3）。
  darkMode: ["selector", '[class~="light"] &'],
  theme: {
    extend: {
      colors: {
        // 語意化色彩以 CSS 變數驅動，rgb(var(--x) / <alpha-value>) 讓 text-fg/60 等透明度語法照常運作。
        app: "rgb(var(--c-app) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        elevated: "rgb(var(--c-elevated) / <alpha-value>)",
        inset: "rgb(var(--c-inset) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        // 次要文字（上游 --muted，主題代碼的第四色）。
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        success: "rgb(var(--c-success) / <alpha-value>)",
        warning: "rgb(var(--c-warning) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
      },
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        DEFAULT: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
      },
      fontSize: {
        "2xs": ["10px", "14px"],
      },
    },
  },
  plugins: [],
};

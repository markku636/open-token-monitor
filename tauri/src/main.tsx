import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { t } from "./i18n";
// 自我托管字體（離線內嵌，不連 CDN；CSP 也不允許外部字型）。
import "@fontsource-variable/inter";
import "./styles.css";

// 全域錯誤邊界：任一渲染錯誤時顯示訊息與重載鈕，避免透明視窗整片空白、使用者以為程式當掉。
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="widget-shell flex h-full flex-col items-start gap-3 p-4">
          <div className="text-sm text-danger">{t("發生未預期的錯誤")}</div>
          <pre className="max-h-40 w-full overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 text-2xs text-fg/60">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-sm bg-accent px-3 py-1.5 text-sm text-app"
          >
            {t("重新載入")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

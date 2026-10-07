import { useEffect } from "react";
import { Dashboard } from "./Dashboard";
import { Dock } from "./Dock";
import Settings from "./Settings";
import Widget from "./Widget";
import { useApp } from "./store";

export default function App() {
  const bootstrap = useApp((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  const view = document.documentElement.dataset.view;
  if (view === "dock") return <Dock />;
  if (view === "dashboard") return <Dashboard />;
  return view === "settings" ? <Settings /> : <Widget />;
}

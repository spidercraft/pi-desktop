import React from "react";
import { createRoot } from "react-dom/client";
import "@pi-desktop/ui-kit/tokens.css";
import "./styles.css";
import { App } from "./App.js";
import { applyTheme, loadTheme } from "./theme.js";

applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

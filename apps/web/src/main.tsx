import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./workspace.css";
import "./memory-table-navigation.css";
import "./memory-table-workspace.css";
import "./field-editor.css";
import "./memory-records.css";
import "./record-history.css";
import "./query-chat.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

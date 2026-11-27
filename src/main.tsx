import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import App from "./App";

if (/Mac|iPhone|iPad/.test(navigator.userAgent)) {
  document.documentElement.classList.add("platform-macos");
}

// Suppress the webview's own context menu (Reload / Inspect Element); the app renders its own.
window.addEventListener("contextmenu", (event) => event.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

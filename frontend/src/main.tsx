import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { captureInstallPrompt } from "./lib/v2/push";
import "./index.css";

// Chrome / Edge / Android: keep "Install app" for the alerts dialog's button.
captureInstallPrompt();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

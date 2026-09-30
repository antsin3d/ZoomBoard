import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeDeepLinks } from "./collaboration/deepLinks";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

void initializeDeepLinks();

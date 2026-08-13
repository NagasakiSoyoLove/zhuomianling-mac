import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelpApp } from "./HelpApp";
import "./help.css";

const root = document.getElementById("help-root");

if (!root) {
  throw new Error("Help page root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <HelpApp />
  </StrictMode>
);

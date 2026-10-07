import { createRoot } from "react-dom/client";
import "../../runtracker/static/style.css";   // tokens, tables, words: shared with exported pages
import "./app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);

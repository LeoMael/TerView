import ReactDOM from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles/theme.css";

// Sin React.StrictMode: su doble montaje abriría dos veces terminales/conexiones reales.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

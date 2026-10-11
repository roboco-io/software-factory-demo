import { HashRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthContext";
import { Header } from "./components/Header";

export function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Header />
        <Routes>
          <Route path="*" element={<div className="container page">Loading…</div>} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}

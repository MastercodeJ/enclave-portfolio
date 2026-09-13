import { Routes, Route } from "react-router-dom";
import { Header } from "@/components/Header";
import { HomePage } from "@/pages/Home";
import { DashboardPage } from "@/pages/Dashboard";

export function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/position" element={<HomePage />} />
      </Routes>
    </>
  );
}

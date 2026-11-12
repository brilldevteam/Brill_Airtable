import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { BasePage } from "./pages/BasePage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { PublicFormPage } from "./pages/PublicFormPage";
import { PublicViewPage } from "./pages/PublicViewPage";

export function App() {
  const { pathname } = useLocation();
  // Shared forms and views are public: no sign-in, no account lookup.
  if (pathname.startsWith("/f/") || pathname.startsWith("/v/")) {
    return (
      <Routes>
        <Route path="/f/:token" element={<PublicFormPage />} />
        <Route path="/v/:token" element={<PublicViewPage />} />
      </Routes>
    );
  }
  return <SignedInApp />;
}

function SignedInApp() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  if (me.isLoading) return <div className="center"><div className="spinner" /></div>;
  if (me.isError) return <div className="center error">Can't reach the server. Is the API running?</div>;
  const user = me.data?.user;

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<HomePage user={user} />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/base/:baseId" element={<BasePage />} />
      <Route path="/base/:baseId/:tableId" element={<BasePage />} />
      <Route path="/base/:baseId/:tableId/:viewId" element={<BasePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

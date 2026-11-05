import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { usePartners } from "./lib/data";
import { Loading } from "./components/ui";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Money from "./pages/Money";
import Projects from "./pages/Projects";
import ProjectPage from "./pages/ProjectPage";
import TimePage from "./pages/Time";
import Tasks from "./pages/Tasks";
import CalendarPage from "./pages/Calendar";

const LINKS = [
  ["/", "ראשי"], ["/money", "כספים"], ["/projects", "פרויקטים"],
  ["/time", "זמן"], ["/tasks", "משימות"], ["/calendar", "יומן"],
] as const;

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <Loading />;
  if (!session) return <Login />;
  return <Shell email={session.user.email ?? ""} />;
}

function Shell({ email }: { email: string }) {
  // RLS returns no partners at all to a user who is not linked to one.
  const partners = usePartners();
  if (partners.isLoading) return <Loading />;
  if (!partners.data?.length) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <p className="text-[22px] font-semibold">החשבון {email} לא מקושר לשותפה.</p>
          <p className="mt-2 text-mute">אפשר להיכנס רק עם המייל של מירי או של ריקי.</p>
          <button className="mt-6 text-pink" onClick={() => supabase.auth.signOut()}>יציאה</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh pb-28 md:pb-16">
      {/* Floating glass pill nav: on top on desktop, at the bottom on mobile */}
      <nav className="glass-nav fixed inset-x-0 bottom-4 z-40 mx-auto flex w-max max-w-[calc(100vw-24px)] items-center gap-1 overflow-x-auto rounded-full px-2 py-2 md:top-5 md:bottom-auto">
        <span className="hidden px-4 text-[18px] font-bold tracking-tight md:inline">aRLi</span>
        {LINKS.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === "/"}
            className={({ isActive }) => `whitespace-nowrap rounded-full px-3.5 py-1.5 text-[15px] font-medium transition-colors ${isActive ? "bg-pink text-ink" : "text-mute hover:text-bone"}`}>
            {label}
          </NavLink>
        ))}
        <button onClick={() => supabase.auth.signOut()} className="hidden px-3 text-[14px] text-mute-2 hover:text-bone md:inline">יציאה</button>
      </nav>

      <main className="mx-auto max-w-[1180px] px-[var(--gutter)] pt-10 md:pt-32">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/money" element={<Money />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/time" element={<TimePage />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/calendar" element={<CalendarPage />} />
        </Routes>
      </main>
    </div>
  );
}

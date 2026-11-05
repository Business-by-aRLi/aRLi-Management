import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { usePartners } from "./lib/data";
import { Button, IconButton, Loading, Modal } from "./components/ui";
import { Icon, type IconName } from "./components/icons";
import { QuickAdd } from "./components/QuickAdd";
import Login, { SET_PASSWORD_FLAG, SetPassword } from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Money from "./pages/Money";
import Projects from "./pages/Projects";
import ProjectPage from "./pages/ProjectPage";
import TimePage from "./pages/Time";
import Tasks from "./pages/Tasks";
import CalendarPage from "./pages/Calendar";

// Order follows daily use: plan first (home, tasks, calendar), then the books.
const LINKS: [string, string, IconName][] = [
  ["/", "בית", "home"], ["/tasks", "משימות", "tasks"], ["/calendar", "יומן", "calendar"],
  ["/projects", "פרויקטים", "projects"], ["/money", "כספים", "money"], ["/time", "זמן", "time"],
];
// On a phone the tab bar holds four places and the "+"; the rest live under "עוד".
const PHONE_TABS = LINKS.slice(0, 2).concat(LINKS.slice(4, 5));
const PHONE_MORE = [LINKS[2], LINKS[3], LINKS[5]];

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const needsPassword = () => { try { return localStorage.getItem(SET_PASSWORD_FLAG) === "1"; } catch { return false; } };
  const [setPw, setSetPw] = useState(needsPassword());

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setSetPw(true);
      if (event === "SIGNED_IN") setSetPw(needsPassword());
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <Loading />;
  if (!session) return <Login />;
  if (setPw) return <SetPassword onDone={() => setSetPw(false)} />;
  return <Shell email={session.user.email ?? ""} />;
}

function Shell({ email }: { email: string }) {
  // RLS returns no partners at all to a user who is not linked to one.
  const partners = usePartners();
  const [askLogout, setAskLogout] = useState(false);
  const [adding, setAdding] = useState(false);
  const [more, setMore] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const moreActive = PHONE_MORE.some(([to]) => pathname.startsWith(to));
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
    <div className="min-h-dvh pb-32 lg:pb-16">
      {/* Desktop: floating glass pill on top, with the "+" at its end */}
      <nav aria-label="ניווט ראשי" className="glass-nav fixed inset-x-0 top-5 z-40 mx-auto hidden w-max items-center gap-1 rounded-full px-2 py-2 lg:flex">
        <span className="px-4 text-[18px] font-bold tracking-tight">aRLi</span>
        {LINKS.map(([to, label, icon]) => (
          <NavLink key={to} to={to} end={to === "/"}
            className={({ isActive }) => `press inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[15px] font-medium transition-colors duration-300 ${isActive ? "bg-[var(--ink-3)] text-bone shadow-[inset_0_0_0_1px_var(--line-2)]" : "text-mute hover:text-bone"}`}>
            <Icon name={icon} size={17} />{label}
          </NavLink>
        ))}
        <Button className="!py-1.5 !px-4 ms-1 text-[15px]" onClick={() => setAdding(true)}><Icon name="plus" size={17} />חדש</Button>
        <IconButton icon="logout" label="יציאה" onClick={() => setAskLogout(true)} />
      </nav>

      {/* Phone: a fixed tab bar with icons, the "+" in the middle */}
      <nav aria-label="ניווט ראשי" className="tabbar glass-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 items-end rounded-t-[24px] px-2 pt-2 lg:hidden">
        <Tab {...tabProps(PHONE_TABS[0])} />
        <Tab {...tabProps(PHONE_TABS[1])} />
        <button onClick={() => setAdding(true)} aria-label="הוספה" className="press mx-auto mb-1 grid size-14 -translate-y-3 place-items-center rounded-full bg-pink text-ink">
          <Icon name="plus" size={26} strokeWidth={2.2} />
        </button>
        <Tab {...tabProps(PHONE_TABS[2])} />
        <button onClick={() => setMore(true)} className={`press flex flex-col items-center gap-1 py-1.5 text-[12px] font-medium ${moreActive ? "text-pink-soft" : "text-mute"}`}>
          <Icon name="more" size={24} strokeWidth={3} />עוד
        </button>
      </nav>

      <Modal open={more} onClose={() => setMore(false)} title="עוד">
        <div className="grid gap-1">
          {PHONE_MORE.map(([to, label, icon]) => (
            <NavLink key={to} to={to} onClick={() => setMore(false)}
              className={({ isActive }) => `row-btn flex items-center gap-3 py-3.5 text-[18px] font-medium ${isActive ? "text-pink-soft" : ""}`}>
              <Icon name={icon} size={22} />{label}
            </NavLink>
          ))}
          <button onClick={() => { setMore(false); setAskLogout(true); }} className="row-btn flex items-center gap-3 py-3.5 text-start text-[18px] font-medium text-mute">
            <Icon name="logout" size={22} />יציאה
          </button>
        </div>
      </Modal>

      <QuickAdd open={adding} onClose={() => setAdding(false)} />

      <Modal open={askLogout} onClose={() => setAskLogout(false)} title="להתנתק מהמערכת?">
        <p className="mb-6 text-mute">בכניסה הבאה תצטרכי את המייל והסיסמה.</p>
        <div className="flex gap-3">
          <Button arrow className="group" onClick={() => supabase.auth.signOut()}>כן, להתנתק</Button>
          <Button variant="ghost" onClick={() => setAskLogout(false)}>להישאר</Button>
        </div>
      </Modal>

      <main className="mx-auto max-w-[1180px] px-[var(--gutter)] pt-8 lg:pt-32">
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

const tabProps = ([to, label, icon]: [string, string, IconName]) => ({ to, label, icon });
function Tab({ to, label, icon }: { to: string; label: string; icon: IconName }) {
  return (
    <NavLink to={to} end={to === "/"}
      className={({ isActive }) => `press flex flex-col items-center gap-1 py-1.5 text-[12px] font-medium transition-colors ${isActive ? "text-pink-soft" : "text-mute"}`}>
      <Icon name={icon} size={24} />{label}
    </NavLink>
  );
}

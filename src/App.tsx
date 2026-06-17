import { Routes, Route } from "react-router-dom";
import AppLayout from "./components/layout/AppLayout";
import Home from "./routes/Home";
import TaskMarket from "./routes/TaskMarket";
import CreateTask from "./routes/CreateTask";
import Agents from "./routes/Agents";
import Settlement from "./routes/Settlement";
import Explorer from "./routes/Explorer";
import TaskDetail from "./routes/TaskDetail";
import AgentDetail from "./routes/AgentDetail";
import Profile from "./routes/Profile";
import SettingsPage from "./routes/Settings";

/** App shell (sidebar + topbar) — everything except the marketing landing. */
function AppShell() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/tasks" element={<TaskMarket />} />
        <Route path="/create-task" element={<CreateTask />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/settlement" element={<Settlement />} />
        <Route path="/explorer" element={<Explorer />} />
        <Route path="/task/:id" element={<TaskDetail />} />
        <Route path="/agent/:wallet" element={<AgentDetail />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Standalone marketing landing — no sidebar; "Launch App" enters the shell. */}
      <Route path="/" element={<Home />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}

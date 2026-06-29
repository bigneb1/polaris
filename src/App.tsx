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
import Subscriptions from "./routes/Subscriptions";
import Docs from "./routes/Docs";

/** App shell (sidebar + topbar) - everything except the marketing landing. */
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
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/profile" element={<Profile />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Standalone marketing landing; "Launch App" enters the shell. */}
      <Route path="/" element={<Home />} />
      {/* Docs has its own layout + hamburger, outside the app shell. */}
      <Route path="/docs" element={<Docs />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}

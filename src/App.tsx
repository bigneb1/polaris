import { Routes, Route } from "react-router-dom";
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
import PlanDetail from "./routes/PlanDetail";
import DisputeDetail from "./routes/DisputeDetail";
import Docs from "./routes/Docs";

/**
 * Routing is flat now.
 *
 * Each page mounts `AppShell` itself rather than being wrapped by a layout route. That
 * is what lets a page pass its own toolbar and details panel into the chrome, which is
 * the whole point of the studio shell: the toolbar belongs to the page, not to the
 * layout. The landing page and the docs keep their own chrome.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/docs" element={<Docs />} />
      <Route path="/tasks" element={<TaskMarket />} />
      <Route path="/create-task" element={<CreateTask />} />
      <Route path="/agents" element={<Agents />} />
      <Route path="/settlement" element={<Settlement />} />
      <Route path="/explorer" element={<Explorer />} />
      <Route path="/task/:id" element={<TaskDetail />} />
      <Route path="/agent/:wallet" element={<AgentDetail />} />
      <Route path="/subscriptions" element={<Subscriptions />} />
      <Route path="/plan/:planId" element={<PlanDetail />} />
      <Route path="/dispute/:disputeId" element={<DisputeDetail />} />
      <Route path="/profile" element={<Profile />} />
    </Routes>
  );
}

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { PageSkeleton, Skeleton } from './components/ui';
import { useProfile } from './state/ProfileContext';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Actions } from './pages/Actions';
import { Goals } from './pages/Goals';
import { Scenarios } from './pages/Scenarios';
import { Portfolio } from './pages/Portfolio';
import { Assistant } from './pages/Assistant';
import { Assumptions } from './pages/Assumptions';
import { Profile } from './pages/Profile';

/**
 * Routing.
 *
 * Every screen except onboarding requires a loaded profile, so the guard lives
 * here rather than being repeated in each page. That is what lets the pages use
 * `useLoadedProfile()` and treat the profile as non-null.
 */

const TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/actions': 'Next Best Actions',
  '/goals': 'Goals',
  '/scenarios': 'Scenario Lab',
  '/portfolio': 'Portfolio',
  '/assistant': 'AI Assistant',
  '/assumptions': 'Assumptions',
  '/profile': 'My Details',
};

function Protected({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useProfile();
  const location = useLocation();
  const title = TITLES[location.pathname] ?? 'AI Wealth Navigator';

  // The saved plan is being restored: show the page's shape, not a spinner.
  if (loading) {
    return (
      <Shell title={title}>
        <PageSkeleton />
      </Shell>
    );
  }
  if (!profile) return <Navigate to="/" replace />;

  return <Shell title={title}>{children}</Shell>;
}

/** Before we know whether there is a saved plan to go back to. */
function StartLoading() {
  return (
    <div className="onboarding" role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="onboarding-card onboarding-body stack-sm" aria-hidden="true">
        <Skeleton variant="title" />
        <Skeleton />
        <Skeleton width="70%" />
      </div>
    </div>
  );
}

export function App() {
  const { profile, loading } = useProfile();

  return (
    <Routes>
      <Route
        path="/"
        element={
          loading ? (
            <StartLoading />
          ) : profile ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <Onboarding />
          )
        }
      />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/actions" element={<Protected><Actions /></Protected>} />
      <Route path="/goals" element={<Protected><Goals /></Protected>} />
      <Route path="/scenarios" element={<Protected><Scenarios /></Protected>} />
      <Route path="/portfolio" element={<Protected><Portfolio /></Protected>} />
      <Route path="/assistant" element={<Protected><Assistant /></Protected>} />
      <Route path="/assumptions" element={<Protected><Assumptions /></Protected>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      {/* Unknown paths go home rather than showing a dead end. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

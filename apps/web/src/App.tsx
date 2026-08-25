import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { authClient } from "./lib/auth";
import { claimLocalSession, isLoopbackOrigin } from "./lib/local-session";
import { SESSION_RETRY_MS, sessionGate } from "./lib/session-gate";

const AccountPage = lazy(() => import("./pages/Account").then((m) => ({ default: m.AccountPage })));
const EnterCodePage = lazy(() =>
  import("./pages/EnterCode").then((m) => ({ default: m.EnterCodePage })),
);
const AuthPage = lazy(() => import("./pages/Auth").then((m) => ({ default: m.AuthPage })));
const BillingPage = lazy(() => import("./pages/Billing").then((m) => ({ default: m.BillingPage })));
const MachineSettingsPage = lazy(() =>
  import("./pages/MachineSettings").then((m) => ({ default: m.MachineSettingsPage })),
);
const PhoneConnectPage = lazy(() =>
  import("./pages/PhoneConnect").then((m) => ({ default: m.PhoneConnectPage })),
);
const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((m) => ({ default: m.OnboardingPage })),
);
const PluginsCallbackPage = lazy(() =>
  import("./pages/PluginsCallback").then((m) => ({ default: m.PluginsCallbackPage })),
);
const ShellPage = lazy(() => import("./pages/Shell").then((m) => ({ default: m.ShellPage })));
const WelcomePage = lazy(() => import("./pages/Welcome").then((m) => ({ default: m.WelcomePage })));

function LoadingPage() {
  return (
    <div className="qb-loading-page grid h-full place-items-center text-[#737378]">
      <div className="qb-loading-page__content">
        <span className="qb-loading-page__dot" />
        <span>Carregando seu time…</span>
      </div>
    </div>
  );
}

function UnreachablePage({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="qb-loading-page grid h-full place-items-center text-[#737378]">
      <div className="qb-loading-page__content text-center">
        <p>O servidor ainda não respondeu.</p>
        <button type="button" className="qb-secondary-button mt-4" onClick={onRetry}>
          Tentar de novo
        </button>
      </div>
    </div>
  );
}

export function App() {
  const session = authClient.useSession();
  const [retries, setRetries] = useState(0);
  // Nesta máquina, abrir o app é entrar: tenta a sessão local antes de mostrar
  // qualquer tela de entrada. Ver apps/web/src/lib/local-session.ts.
  const [localTried, setLocalTried] = useState(false);
  const gate = sessionGate(
    { isPending: session.isPending, hasUser: Boolean(session.data?.user), error: session.error },
    retries,
  );

  // A API pode subir depois da UI: refaz o get-session em vez de dar o usuário por deslogado.
  useEffect(() => {
    if (gate !== "loading" || session.isPending || !session.error) return;
    const timer = setTimeout(() => {
      setRetries((count) => count + 1);
      void session.refetch();
    }, SESSION_RETRY_MS);
    return () => clearTimeout(timer);
  }, [gate, session]);

  useEffect(() => {
    if (localTried || gate !== "signed-out" || !isLoopbackOrigin()) return;
    setLocalTried(true);
    void claimLocalSession().then((entered) => {
      if (entered) void session.refetch();
    });
  }, [gate, localTried, session]);

  if (gate === "loading" || (gate === "signed-out" && isLoopbackOrigin() && !localTried)) {
    return <LoadingPage />;
  }
  if (gate === "unreachable") {
    return <UnreachablePage onRetry={() => void session.refetch()} />;
  }
  const user = session.data?.user;
  return (
    <Suspense fallback={<LoadingPage />}>
      <Routes>
        <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
        <Route
          path="/entrar-com-codigo"
          element={user ? <Navigate to="/app" replace /> : <EnterCodePage />}
        />
        {/* Rota antiga: cadastro e entrada agora são o nome e o código. */}
        <Route path="/sign-in" element={<Navigate to="/entrar-com-codigo" replace />} />
        <Route
          path="/sign-up"
          element={user ? <Navigate to="/onboarding" replace /> : <AuthPage />}
        />
        <Route
          path="/onboarding"
          element={user ? <OnboardingPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/account"
          element={user ? <AccountPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/billing"
          element={user ? <BillingPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/settings/machine"
          element={user ? <MachineSettingsPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/settings/phone"
          element={user ? <PhoneConnectPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/plugins/callback"
          element={user ? <PluginsCallbackPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/app"
          element={user ? <ShellPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/app/g/:groupId"
          element={user ? <ShellPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
        <Route
          path="/app/:botId"
          element={user ? <ShellPage /> : <Navigate to="/entrar-com-codigo" replace />}
        />
      </Routes>
    </Suspense>
  );
}

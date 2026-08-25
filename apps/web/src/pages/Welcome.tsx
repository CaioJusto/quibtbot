import { useNavigate } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="qb-welcome app-drag relative flex min-h-full flex-col overflow-hidden px-10 pt-5 pb-10 max-[720px]:px-5">
      <div className="qb-welcome__chrome shrink-0">
        <WindowChrome />
      </div>
      <div className="qb-welcome__body mx-auto grid min-h-0 w-full max-w-[1180px] flex-1 items-center gap-10 lg:grid-cols-[.92fr_1.08fr]">
        <div className="qb-welcome__copy text-left max-[900px]:order-2 max-[900px]:mx-auto max-[900px]:max-w-[640px] max-[900px]:text-center">
          <div className="qb-kicker mb-4">Seu time sempre ligado</div>
          <h1>Trabalho andando, mesmo quando você não está.</h1>
          <p>
            Crie bots especialistas, dê uma missão a cada um e acompanhe tudo em uma única conversa.
            Cada personagem tem memória, rotinas e um computador pronto para agir.
          </p>
          <div className="app-no-drag mt-8 flex gap-3 max-[900px]:justify-center max-[560px]:flex-col">
            <button
              type="button"
              onClick={() => navigate("/sign-up")}
              className="qb-primary-button"
            >
              Começar agora
            </button>
            <button
              type="button"
              onClick={() => navigate("/entrar-com-codigo")}
              className="qb-secondary-button"
            >
              Tenho um código
            </button>
          </div>
          <div className="qb-welcome__proof mt-7">
            <span>Local-first</span>
            <span>Open source</span>
            <span>Seu modelo, seus dados</span>
          </div>
        </div>
        <div className="qb-welcome__visual max-[900px]:order-1">
          <div className="qb-welcome__visual-card" aria-hidden="true">
            <img src="/quibt-onboarding-team.png" alt="" draggable={false} />
            <div className="qb-welcome__status qb-welcome__status--top">
              <span className="qb-live-dot" /> Dora organizou 18 conversas
            </div>
            <div className="qb-welcome__status qb-welcome__status--bottom">
              <span className="qb-live-dot qb-live-dot--cyan" /> Nilo terminou a pesquisa
            </div>
          </div>
        </div>
      </div>
      <div className="qb-welcome__footer">
        <span>Quibt Bot</span>
        <span>Um computador. Um time inteiro.</span>
      </div>
    </div>
  );
}

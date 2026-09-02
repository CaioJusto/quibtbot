-- O bot chama request_takeover e o computador fica parado até a pessoa assumir e
-- depois liberar. Sem esta coluna o estado só existia no run, e um clique do
-- agente ainda passava se o controlHolder voltasse a "bot" cedo demais.
ALTER TABLE "desktop_sessions" ADD COLUMN "waitingTakeover" BOOLEAN NOT NULL DEFAULT false;

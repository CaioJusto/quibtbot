-- O cadastro nasce fechado: numa VPS pública, qualquer pessoa podia criar conta, ganhar um
-- computador com Chrome e gastar a chave do dono. Só o padrão muda; a linha "default" que já
-- existe mantém o que o dono escolheu (o primeiro dono entra pelo código do instalador).
ALTER TABLE "deployment_settings" ALTER COLUMN "signupsEnabled" SET DEFAULT false;

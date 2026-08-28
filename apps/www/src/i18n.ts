export type Locale = "en" | "pt-BR";
export type PageKey = "home" | "privacy" | "terms";

export const ROUTES: Record<Locale, Record<PageKey, string>> = {
  en: {
    home: "/",
    privacy: "/privacy",
    terms: "/terms",
  },
  "pt-BR": {
    home: "/pt/",
    privacy: "/pt/privacidade",
    terms: "/pt/termos",
  },
};

export const COPY = {
  en: {
    languageName: "English",
    alternateLanguageName: "Português",
    skipLink: "Skip to content",
    metaDescription:
      "Quibt Bot is the open-source alternative to Grok Bot. Create AI bots with personality, memory, and their own computer.",
    socialAlt: "Quibt Bot — the open-source alternative to Grok Bot.",
    nav: {
      label: "Main navigation",
      menuLabel: "Menu",
      openMenu: "Open menu",
      product: "Product",
      how: "How it works",
      openSource: "Open source",
      download: "Download",
      downloadShort: "Download",
      github: "GitHub",
      docs: "Self-host",
    },
    footer: {
      label: "Footer",
      github: "GitHub",
      privacy: "Privacy",
      terms: "Terms",
    },
    landing: {
      status: {
        badge: "Live",
        text: "is out — the whole product is open source on GitHub",
      },
      title: "The open-source alternative to Grok Bot.",
      lead:
        "Create AI bots with personality, memory, and their own computer. You choose the AI, follow the work, and can run Quibt in your own environment.",
      downloadMac: "Download for macOS",
      downloadWin: "Download for Windows",
      downloadLinux: "Download for Linux",
      downloadMacNoteNotarized:
        "macOS: Apple silicon · .dmg signed and notarized by Apple, opens with no warning · Intel Macs: no installer yet — run from source (see README)",
      downloadMacNoteUnsigned:
        "macOS: Apple silicon · unsigned .dmg, macOS warns — the first time: right-click → Open · Intel Macs: no installer yet — run from source (see README)",
      downloadWinNote:
        "Windows: 64-bit test installer, unsigned — SmartScreen warns: More info → Run anyway · install Docker Desktop yourself",
      downloadLinuxNote:
        "Linux: x64 test AppImage, unsigned · needs libfuse2, mark it executable · install Docker (Engine or Desktop) yourself",
      downloadLatest: "these three links are pinned to",
      downloadReleases: "all releases",
      downloadEyebrow: "Install",
      downloadTitle: "Run it on your own machine.",
      downloadCopy: "Download the desktop app for your OS, or install the open-source server with one command.",
      installCommandLabel: "Or install the server with one command",
      copyCommand: "Copy",
      copied: "Copied",
      mascotStageLabel: "The Quibt Bot character family",
      mascotAlts: {
        blue: "Blue Quibt Bot character",
        yellow: "Yellow Quibt Bot character",
        pink: "Pink Quibt Bot character",
        cyan: "Cyan Quibt Bot character",
      },
      howEyebrow: "How it works",
      howTitle: "You create it. It understands. Work moves forward.",
      howCopy:
        "Give it a name, choose its look, and show it what needs to be done. Every bot has its own screen, keeps context, and comes back when it needs your decision.",
      steps: [
        {
          title: "Install the server",
          copy: "Run the Docker Compose stack on this computer or your own VPS. Apache 2.0, source available.",
        },
        {
          title: "Bring a model",
          copy: "Paste an OpenRouter key, point at a local Ollama or LM Studio URL, or use a ChatGPT, Copilot, or SuperGrok subscription.",
        },
        {
          title: "Pick the computer",
          copy: "Docker on this machine by default, or your own VPS, E2B, or Box — each bot keeps its own screen.",
        },
        {
          title: "Create a bot",
          copy: "Give it a name, a look, and the first job. It keeps context and comes back when it needs your call.",
        },
      ],
      charactersEyebrow: "Characters",
      charactersTitle: "Bots with personality, not generic chats",
      charactersCopy:
        "You create the characters and choose each role. Together, they become a team built around your routine.",
      characters: [
        {
          name: "Kibo",
          alt: "Kibo, blue character",
          copy: "Turns scattered requests into a clear daily plan and marks what still needs your call.",
        },
        {
          name: "Meli",
          alt: "Meli, yellow character",
          copy: "Connects signals across sources and turns them into concise, traceable briefs.",
        },
        {
          name: "Zazu",
          alt: "Zazu, cyan character",
          copy: "Keeps relationships warm, remembers context, and prepares the next conversation.",
        },
        {
          name: "Tuca",
          alt: "Tuca, pink character",
          copy: "Closes loops across tools, schedules follow-ups, and records what changed.",
        },
      ],
      openEyebrow: "Open source",
      openTitle: "Your bot. Your model. Your infrastructure.",
      openCopy: "Inspect the code, bring your own AI, and choose where Quibt runs.",
      stats: [
        { value: "Apache 2.0", label: "Open license" },
        { value: "Self-host", label: "Run it in your environment" },
        { value: "Your AI", label: "Choose the model" },
        { value: "Your control", label: "Auditable code" },
      ],
    },
    privacy: {
      title: "Privacy Policy",
      description: "What the Quibt Bot website collects: no account, no form, no database.",
      intro:
        "This policy covers the public Quibt Bot website at quibt.com.br. The site is a set of static pages: there is no form, no sign-up, and no Quibt database behind it. Quibt Bot itself is open-source software you install and run on your own machine.",
      lastUpdated: "Last updated: August 28, 2026.",
      sections: [
        {
          title: "1. What we collect",
          body: "Nothing you type. The site has no form, no login, and no newsletter, so it does not collect your name, your e-mail address, or any other detail about you.",
        },
        {
          title: "2. Technical data of the visit",
          body: "The hosting provider that serves these pages (Vercel) receives ordinary connection data, such as IP address, date, and browser headers, to deliver and protect the site. Those are the provider's server logs. Quibt keeps no visitor database of its own.",
        },
        {
          title: "3. What the page loads from third parties",
          body: "The pages load web fonts from Google Fonts, so your browser asks Google for those files. Download and documentation buttons send you to GitHub. Each of those companies receives that request under its own policy. There is no advertising and no tracking pixel on this site.",
        },
        {
          title: "4. Cookies",
          body: "The site sets no cookie of its own and runs no analytics script. Changing the language is a link to another page, not stored data.",
        },
        {
          title: "5. Your Quibt Bot install",
          body: "When you install Quibt Bot, the database, the bot files, and your model keys stay on the machine you installed onto. That data never reaches Quibt. If you point the product at another company (a model provider, E2B, Box, or Composio), that relationship and that data are between you and them.",
        },
        {
          title: "6. Why the logs exist",
          body: "Server logs exist to deliver the pages, keep the site available, and defend it from abuse — our legitimate interest in operating the site. They are kept for the short period the provider applies and are not used to profile anyone.",
        },
        {
          title: "7. Your rights",
          body: "Subject to applicable law, you may ask what data about you exists, ask for a copy, ask for correction, or ask for deletion. Write to caio@liaforschool.com.br. As the site keeps no registration, the answer is normally that nothing exists beyond the provider's short server log.",
        },
        {
          title: "8. Children",
          body: "The site is informational and asks nobody, at any age, for personal data.",
        },
        {
          title: "9. Changes",
          body: "We may update this policy as the product develops. A material change is published on this page with a new update date.",
        },
      ],
    },
    terms: {
      title: "Website Terms",
      description: "Terms for using the public Quibt Bot website. The software itself is Apache-2.0.",
      intro:
        "These terms apply to this public website. They do not replace the software licence: Quibt Bot is released under Apache-2.0, and that licence governs the code you download, install, and run.",
      lastUpdated: "Last updated: August 28, 2026.",
      sections: [
        {
          title: "1. What this site is",
          body: "An informational site about an open-source product. It sells nothing, hosts no account, and has no form. It links to the source code and to the release files on GitHub.",
        },
        {
          title: "2. Permitted use",
          body: "You may read the pages, copy the install command, and download the release files. You may not probe the site for vulnerabilities, interfere with its operation, impersonate another person, or use it unlawfully. To report a security problem, follow SECURITY.md in the repository.",
        },
        {
          title: "3. The software is licensed separately",
          body: "The code is under Apache-2.0, as published in the repository. It is provided as is, without warranty, to the extent that licence allows. Downloading a build does not create a support contract.",
        },
        {
          title: "4. You run your own install",
          body: "When you install Quibt Bot, the server, the bots, and their computers run on infrastructure you choose. That install is yours: the secrets, the access you open, the models you connect, and what the bots do for you.",
        },
        {
          title: "5. No payment on this site",
          body: "The site collects no payment data and creates no subscription. Any cost comes from the third parties you choose — the model provider, the sandbox provider, or your own server — and is paid directly to them.",
        },
        {
          title: "6. Intellectual property",
          body: "The Quibt name, the logo, the characters, and the website text remain protected by applicable law, even though the source code is open. The Apache-2.0 licence grants no trademark rights.",
        },
        {
          title: "7. Availability and changes",
          body: "The site and the release files are provided as available. To the extent permitted by law, we do not promise uninterrupted access, and what is described here may change between releases.",
        },
        {
          title: "8. Liability",
          body: "Nothing here excludes rights or liabilities that cannot legally be excluded. Subject to that limit, Quibt is not responsible for indirect losses arising from reliance on this website's material or from temporary unavailability.",
        },
        {
          title: "9. Governing law",
          body: "Brazilian law governs these terms. Any dispute will be handled by the competent courts determined under applicable consumer and procedural law.",
        },
      ],
    },
  },

  "pt-BR": {
    languageName: "Português",
    alternateLanguageName: "English",
    skipLink: "Pular para o conteúdo",
    metaDescription:
      "Quibt Bot é a alternativa open source ao Grok Bot: crie bots de IA com personalidade, memória e um computador próprio.",
    socialAlt: "Quibt Bot — a alternativa open source ao Grok Bot.",
    nav: {
      label: "Navegação principal",
      menuLabel: "Menu",
      openMenu: "Abrir menu",
      product: "Produto",
      how: "Como funciona",
      openSource: "Open source",
      download: "Baixar",
      downloadShort: "Baixar",
      github: "GitHub",
      docs: "Self-host",
    },
    footer: {
      label: "Rodapé",
      github: "GitHub",
      privacy: "Privacidade",
      terms: "Termos",
    },
    landing: {
      status: {
        badge: "No ar",
        text: "publicado — o produto inteiro é open source no GitHub",
      },
      title: "A alternativa open source ao Grok Bot.",
      lead:
        "Crie bots de IA com personalidade, memória e um computador próprio. Você escolhe a IA, acompanha o trabalho e pode rodar o Quibt no seu ambiente.",
      downloadMac: "Baixar para macOS",
      downloadWin: "Baixar para Windows",
      downloadLinux: "Baixar para Linux",
      downloadMacNoteNotarized:
        "macOS: Apple silicon · .dmg assinado e notarizado pela Apple, abre sem aviso · Mac Intel: ainda sem instalador — só rodando a partir do código-fonte (veja o README)",
      downloadMacNoteUnsigned:
        "macOS: Apple silicon · .dmg sem assinatura, o macOS avisa — na primeira vez: botão direito → Abrir · Mac Intel: ainda sem instalador — só rodando a partir do código-fonte (veja o README)",
      downloadWinNote:
        "Windows: instalador de teste 64 bits, sem assinatura — o SmartScreen avisa: Mais informações → Executar assim mesmo · instale o Docker Desktop por conta própria",
      downloadLinuxNote:
        "Linux: AppImage x64 de teste, sem assinatura · precisa de libfuse2, marque como executável · instale o Docker (Engine ou Desktop) por conta própria",
      downloadLatest: "os três links apontam para a",
      downloadReleases: "todos os releases",
      downloadEyebrow: "Instalar",
      downloadTitle: "Rode na sua própria máquina.",
      downloadCopy: "Baixe o app de desktop para o seu sistema, ou instale o servidor open source com um comando.",
      installCommandLabel: "Ou instale o servidor com um comando",
      copyCommand: "Copiar",
      copied: "Copiado",
      mascotStageLabel: "A família de personagens do Quibt Bot",
      mascotAlts: {
        blue: "Personagem azul do Quibt Bot",
        yellow: "Personagem amarelo do Quibt Bot",
        pink: "Personagem rosa do Quibt Bot",
        cyan: "Personagem ciano do Quibt Bot",
      },
      howEyebrow: "Como funciona",
      howTitle: "Você cria. Ele entende. O trabalho anda.",
      howCopy:
        "Dê um nome, escolha a aparência e mostre o que precisa ser feito. Cada bot tem a própria tela, mantém o contexto e volta quando precisa de uma decisão sua.",
      steps: [
        {
          title: "Instale o servidor",
          copy: "Rode o Docker Compose neste computador ou na sua própria VPS. Apache 2.0, código disponível.",
        },
        {
          title: "Traga um modelo",
          copy: "Cole uma chave OpenRouter, aponte para um Ollama ou LM Studio local, ou use uma assinatura ChatGPT, Copilot ou SuperGrok.",
        },
        {
          title: "Escolha o computador",
          copy: "Docker nesta máquina por padrão, ou sua própria VPS, E2B ou Box — cada bot mantém a própria tela.",
        },
        {
          title: "Crie um bot",
          copy: "Dê um nome, uma aparência e o primeiro trabalho. Ele mantém o contexto e volta quando precisa da sua decisão.",
        },
      ],
      charactersEyebrow: "Personagens",
      charactersTitle: "Bots com personalidade, não chats genéricos",
      charactersCopy:
        "Você cria os personagens e decide a função de cada um. Juntos, eles viram um time feito para a sua rotina.",
      characters: [
        {
          name: "Kibo",
          alt: "Kibo, personagem azul",
          copy: "Transforma pedidos soltos em um plano diário claro e marca o que ainda precisa da sua decisão.",
        },
        {
          name: "Meli",
          alt: "Meli, personagem amarelo",
          copy: "Cruza sinais entre fontes e transforma tudo em resumos curtos e rastreáveis.",
        },
        {
          name: "Zazu",
          alt: "Zazu, personagem ciano",
          copy: "Mantém relações aquecidas, lembra o contexto e prepara a próxima conversa.",
        },
        {
          name: "Tuca",
          alt: "Tuca, personagem rosa",
          copy: "Fecha pontas entre ferramentas, agenda retornos e registra o que mudou.",
        },
      ],
      openEyebrow: "Open source",
      openTitle: "Seu bot. Seu modelo. Sua infraestrutura.",
      openCopy: "Inspecione o código, use sua própria IA e escolha onde o Quibt vai rodar.",
      stats: [
        { value: "Apache 2.0", label: "Licença aberta" },
        { value: "Self-host", label: "Rode no seu ambiente" },
        { value: "Sua IA", label: "Escolha o modelo" },
        { value: "Seu controle", label: "Código auditável" },
      ],
    },
    privacy: {
      title: "Política de Privacidade",
      description: "O que o site do Quibt Bot coleta: sem conta, sem formulário, sem banco de dados.",
      intro:
        "Esta política vale para o site público do Quibt Bot, em quibt.com.br. O site é um conjunto de páginas estáticas: não existe formulário, não existe cadastro e não existe banco de dados do Quibt por trás dele. O Quibt Bot é um programa open source que você instala e roda na sua própria máquina.",
      lastUpdated: "Última atualização: 28 de agosto de 2026.",
      sections: [
        {
          title: "1. O que coletamos",
          body: "Nada que você digite. O site não tem formulário, não tem login e não tem newsletter. Ele não coleta seu nome, seu e-mail nem qualquer outro dado seu.",
        },
        {
          title: "2. Dados técnicos da visita",
          body: "O provedor que entrega estas páginas (Vercel) recebe dados normais de conexão, como endereço IP, data e cabeçalhos do navegador, para entregar e proteger o site. Esses são os registros de servidor do provedor. O Quibt não mantém banco de visitantes.",
        },
        {
          title: "3. O que a página carrega de terceiros",
          body: "As páginas carregam fontes do Google Fonts, então o seu navegador pede esses arquivos ao Google. Os botões de download e de documentação levam ao GitHub. Cada uma dessas empresas recebe o pedido segundo a política dela. Não há publicidade nem pixel de rastreio neste site.",
        },
        {
          title: "4. Cookies",
          body: "O site não grava cookie próprio e não roda script de análise. Trocar de idioma é um link para outra página, não um dado guardado.",
        },
        {
          title: "5. A sua instalação do Quibt Bot",
          body: "Quando você instala o Quibt Bot, o banco de dados, os arquivos dos bots e as suas chaves de modelo ficam na máquina em que você instalou. Esses dados não chegam ao Quibt. Se você apontar o produto para outra empresa (um provedor de modelo, E2B, Box ou Composio), a relação e os dados são entre você e ela.",
        },
        {
          title: "6. Por que os registros existem",
          body: "Os registros de servidor existem para entregar as páginas, manter o site no ar e defendê-lo de abuso — nosso legítimo interesse em operar o site. Ficam guardados pelo prazo curto que o provedor aplica e não são usados para traçar perfil de ninguém.",
        },
        {
          title: "7. Seus direitos",
          body: "Nos termos da lei aplicável, você pode perguntar quais dados seus existem, pedir cópia, correção ou exclusão. Escreva para caio@liaforschool.com.br. Como o site não guarda cadastro, a resposta normalmente é que não existe nada além do registro curto de servidor do provedor.",
        },
        {
          title: "8. Crianças",
          body: "O site é informativo e não pede dado pessoal de ninguém, em nenhuma idade.",
        },
        {
          title: "9. Alterações",
          body: "Podemos atualizar esta política conforme o produto evolui. Mudança relevante aparece nesta página com uma nova data de atualização.",
        },
      ],
    },
    terms: {
      title: "Termos do Site",
      description: "Termos para usar o site público do Quibt Bot. O programa em si é Apache-2.0.",
      intro:
        "Estes termos valem para este site público. Eles não substituem a licença do programa: o Quibt Bot é publicado sob Apache-2.0, e é essa licença que rege o código que você baixa, instala e roda.",
      lastUpdated: "Última atualização: 28 de agosto de 2026.",
      sections: [
        {
          title: "1. O que é este site",
          body: "Um site informativo sobre um produto open source. Ele não vende nada, não hospeda conta e não tem formulário. Ele aponta para o código-fonte e para os arquivos de release no GitHub.",
        },
        {
          title: "2. Uso permitido",
          body: "Você pode ler as páginas, copiar o comando de instalação e baixar os arquivos de release. Não é permitido procurar vulnerabilidades no site, atrapalhar o funcionamento dele, se passar por outra pessoa ou usá-lo de forma ilegal. Para relatar um problema de segurança, siga o SECURITY.md do repositório.",
        },
        {
          title: "3. O programa tem licença própria",
          body: "O código está sob Apache-2.0, como publicado no repositório. Ele é fornecido no estado em que está, sem garantia, na medida em que a licença permite. Baixar um instalador não cria contrato de suporte.",
        },
        {
          title: "4. A instalação é sua",
          body: "Quando você instala o Quibt Bot, o servidor, os bots e os computadores deles rodam na infraestrutura que você escolheu. Essa instalação é sua: os segredos, os acessos que você abre, os modelos que você conecta e o que os bots fazem por você.",
        },
        {
          title: "5. Sem pagamento neste site",
          body: "O site não coleta dado de pagamento e não cria assinatura. Qualquer custo vem dos terceiros que você escolhe — o provedor do modelo, o provedor do computador ou o seu próprio servidor — e é pago direto a eles.",
        },
        {
          title: "6. Propriedade intelectual",
          body: "O nome Quibt, o logo, os personagens e o texto do site continuam protegidos pela lei aplicável, mesmo com o código aberto. A licença Apache-2.0 não dá direito de marca.",
        },
        {
          title: "7. Disponibilidade e mudanças",
          body: "O site e os arquivos de release são fornecidos conforme disponíveis. Na medida permitida por lei, não prometemos acesso ininterrupto, e o que está descrito aqui pode mudar de uma release para outra.",
        },
        {
          title: "8. Responsabilidade",
          body: "Nada aqui exclui direitos ou responsabilidades que a lei não permita excluir. Respeitado esse limite, o Quibt não responde por perdas indiretas decorrentes da confiança no material deste site ou de indisponibilidade temporária.",
        },
        {
          title: "9. Lei aplicável",
          body: "A lei brasileira rege estes termos. Eventuais conflitos serão tratados pelos foros competentes definidos pela legislação consumerista e processual aplicável.",
        },
      ],
    },
  },

} as const;

export function copyFor(locale: Locale) {
  return COPY[locale];
}

export function routesFor(locale: Locale) {
  return ROUTES[locale];
}

export function alternateRoutes(page: PageKey) {
  return {
    enHref: ROUTES.en[page],
    ptHref: ROUTES["pt-BR"][page],
  };
}

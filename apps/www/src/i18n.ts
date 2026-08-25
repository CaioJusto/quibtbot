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
      downloadMacNote: "macOS: Apple silicon · one-click .dmg · not Apple-notarized yet",
      downloadWinNote: "Windows: 64-bit · one-click installer, no admin rights · unsigned",
      downloadLinuxNote: "Linux: x64 AppImage · unsigned",
      downloadLatest: "all three always the latest ·",
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
      description: "How Quibt collects, protects, uses, and deletes waitlist information.",
      intro:
        "This policy applies to the public Quibt website and its early-access waitlist. Quibt acts as the controller of the personal data submitted through this form.",
      lastUpdated: "Last updated: August 15, 2026.",
      sections: [
        {
          title: "1. Data we collect",
          body: "When you join the waitlist, we collect your name, email address, role, intended use case, hosting preference, language, consent, and optional X handle. Please do not include sensitive or confidential information in the free-text answer.",
        },
        {
          title: "2. Technical data",
          body: "Vercel and Railway receive ordinary connection data, such as IP address and browser headers, to deliver and secure the site. The Quibt waitlist database does not store your IP address in plain text; it keeps temporary keyed fingerprints for abuse prevention.",
        },
        {
          title: "3. Why we use the data",
          body: "We use your submission only to organize early access, understand initial use cases, contact you about Quibt, prevent fraud and automated abuse, maintain service security, and meet legal obligations. Waitlist communication is based on your consent; security processing relies on our legitimate interest in protecting the service where permitted by law.",
        },
        {
          title: "4. How we protect it",
          body: "Personal fields are encrypted by the application with authenticated AES-256-GCM encryption before they are stored. Email deduplication and rate limiting use keyed, non-reversible HMAC fingerprints. Access is restricted to authorized operators, and there is no public API for reading registrations.",
        },
        {
          title: "5. Service providers and transfers",
          body: "We use Vercel to deliver the website and Railway to run the API and private database. These providers process data on our behalf and may operate infrastructure outside Brazil under their contractual and legal safeguards. We do not sell your personal data.",
        },
        {
          title: "6. Retention",
          body: "Waitlist registrations are kept for up to 365 days after the latest submission or update, unless you ask us to delete them earlier or a legal obligation requires a different period. Expired anti-abuse records are removed periodically.",
        },
        {
          title: "7. Your rights",
          body: "Subject to applicable law, you may request confirmation of processing, access, correction, deletion, information about sharing, portability where applicable, or withdrawal of consent. We may ask for information needed to verify your identity before acting on a request.",
        },
        {
          title: "8. Children",
          body: "The waitlist is intended for people who can validly provide their own information and consent. Do not submit a child's personal data through the form.",
        },
        {
          title: "9. Changes",
          body: "We may update this policy as Quibt develops. Material changes will be reflected on this page with a new update date.",
        },
      ],
    },
    terms: {
      title: "Website and Waitlist Terms",
      description: "Terms for using the Quibt website and joining its early-access waitlist.",
      intro:
        "These terms apply to this public website and the Quibt early-access waitlist. The product is still in development, and joining the waitlist is not a purchase or a guarantee of access.",
      lastUpdated: "Last updated: August 15, 2026.",
      sections: [
        {
          title: "1. Waitlist status",
          body: "A registration records your interest only. It does not guarantee selection, a release date, a particular feature, pricing, availability, or continued operation. We may contact participants in stages and may pause or close the waitlist.",
        },
        {
          title: "2. Your submission",
          body: "You must provide information you are authorized to share and keep it reasonably accurate. Do not place passwords, API keys, confidential business information, unlawful content, or sensitive personal data in the form.",
        },
        {
          title: "3. Permitted use",
          body: "You may browse the site and submit one legitimate registration for yourself or your organization. You may not probe for vulnerabilities, bypass rate limits, automate abusive submissions, interfere with the service, impersonate another person, or use the site unlawfully.",
        },
        {
          title: "4. No payment on this site",
          body: "The public website and waitlist do not collect payment information or create a paid subscription. Any future paid service will present its applicable pricing and terms before purchase.",
        },
        {
          title: "5. Intellectual property and open source",
          body: "Quibt names, branding, characters, and website content remain protected by applicable law. If source code or components are publicly released under an open-source license, that license will govern those materials. These terms do not grant access to a private repository or unpublished code.",
        },
        {
          title: "6. Availability and changes",
          body: "The website and preview information are provided as available and may change during development. To the extent permitted by law, we do not promise uninterrupted access or that previewed features will ship exactly as described.",
        },
        {
          title: "7. Liability",
          body: "Nothing in these terms excludes rights or liabilities that cannot legally be excluded. Subject to that limit, Quibt is not responsible for indirect losses arising only from reliance on preview material or temporary website unavailability.",
        },
        {
          title: "8. Governing law",
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
      downloadMacNote: "macOS: Apple silicon · .dmg de um clique · ainda sem notarização da Apple",
      downloadWinNote: "Windows: 64 bits · instalador de um clique, sem admin · sem assinatura",
      downloadLinuxNote: "Linux: AppImage x64 · sem assinatura",
      downloadLatest: "os três sempre na última versão ·",
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
      description: "Como o Quibt coleta, protege, usa e exclui informações da lista de espera.",
      intro:
        "Esta política se aplica ao site público do Quibt e à lista de espera para acesso antecipado. O Quibt atua como controlador dos dados pessoais enviados pelo formulário.",
      lastUpdated: "Última atualização: 15 de agosto de 2026.",
      sections: [
        {
          title: "1. Dados que coletamos",
          body: "Ao entrar na lista de espera, coletamos nome, e-mail, função, caso de uso pretendido, preferência de hospedagem, idioma, consentimento e, opcionalmente, seu @ no X. Não inclua dados sensíveis ou informações confidenciais na resposta aberta.",
        },
        {
          title: "2. Dados técnicos",
          body: "Vercel e Railway recebem dados normais de conexão, como endereço IP e cabeçalhos do navegador, para entregar e proteger o site. O banco da lista do Quibt não guarda seu IP em texto puro; ele mantém impressões digitais temporárias e protegidas por chave para prevenir abuso.",
        },
        {
          title: "3. Para que usamos os dados",
          body: "Usamos seu cadastro apenas para organizar o acesso antecipado, entender casos de uso iniciais, entrar em contato sobre o Quibt, prevenir fraude e abuso automatizado, manter a segurança do serviço e cumprir obrigações legais. A comunicação da lista se baseia no seu consentimento; o processamento de segurança se apoia em nosso legítimo interesse de proteger o serviço, quando permitido por lei.",
        },
        {
          title: "4. Como protegemos os dados",
          body: "Os campos pessoais são criptografados pela aplicação com AES-256-GCM autenticado antes do armazenamento. A deduplicação de e-mail e o rate limit usam impressões digitais HMAC não reversíveis e protegidas por chave. O acesso é restrito a operadores autorizados e não existe API pública para consultar cadastros.",
        },
        {
          title: "5. Fornecedores e transferências",
          body: "Usamos a Vercel para entregar o site e a Railway para executar a API e o banco privado. Esses fornecedores tratam dados em nosso nome e podem operar infraestrutura fora do Brasil de acordo com suas garantias contratuais e legais. Não vendemos seus dados pessoais.",
        },
        {
          title: "6. Retenção",
          body: "Os cadastros ficam guardados por até 365 dias após o envio ou atualização mais recente, salvo se você pedir a exclusão antes ou se uma obrigação legal exigir outro prazo. Registros antiautomatização expirados são removidos periodicamente.",
        },
        {
          title: "7. Seus direitos",
          body: "Nos termos da lei aplicável, você pode pedir confirmação do tratamento, acesso, correção, exclusão, informação sobre compartilhamento, portabilidade quando aplicável ou revogação do consentimento. Podemos solicitar dados necessários para confirmar sua identidade antes de atender ao pedido.",
        },
        {
          title: "8. Crianças",
          body: "A lista é destinada a pessoas capazes de fornecer validamente os próprios dados e consentimento. Não envie dados pessoais de crianças pelo formulário.",
        },
        {
          title: "9. Alterações",
          body: "Podemos atualizar esta política conforme o Quibt evolui. Mudanças relevantes aparecerão nesta página com uma nova data de atualização.",
        },
      ],
    },
    terms: {
      title: "Termos do Site e da Lista de Espera",
      description: "Termos para usar o site do Quibt e entrar na lista de acesso antecipado.",
      intro:
        "Estes termos se aplicam ao site público e à lista de acesso antecipado do Quibt. O produto ainda está em desenvolvimento; entrar na lista não é uma compra nem uma garantia de acesso.",
      lastUpdated: "Última atualização: 15 de agosto de 2026.",
      sections: [
        {
          title: "1. Situação da lista de espera",
          body: "O cadastro registra apenas seu interesse. Ele não garante seleção, data de lançamento, recurso específico, preço, disponibilidade ou continuidade. Podemos contatar participantes em etapas e pausar ou encerrar a lista.",
        },
        {
          title: "2. Seu cadastro",
          body: "Você deve fornecer somente informações que está autorizado a compartilhar e mantê-las razoavelmente corretas. Não coloque senhas, chaves de API, informações empresariais confidenciais, conteúdo ilegal ou dados pessoais sensíveis no formulário.",
        },
        {
          title: "3. Uso permitido",
          body: "Você pode navegar no site e enviar um cadastro legítimo para si ou sua organização. Não é permitido procurar vulnerabilidades, contornar rate limits, automatizar cadastros abusivos, interferir no serviço, se passar por outra pessoa ou usar o site de forma ilegal.",
        },
        {
          title: "4. Sem pagamento neste site",
          body: "O site público e a lista de espera não coletam dados de pagamento nem criam uma assinatura paga. Um eventual serviço pago apresentará preço e termos aplicáveis antes da compra.",
        },
        {
          title: "5. Propriedade intelectual e open source",
          body: "Os nomes, a marca, os personagens e o conteúdo do site Quibt permanecem protegidos pela lei aplicável. Se códigos ou componentes forem publicados sob licença open source, essa licença regerá esses materiais. Estes termos não dão acesso a repositório privado ou código ainda não publicado.",
        },
        {
          title: "6. Disponibilidade e mudanças",
          body: "O site e as informações de prévia são fornecidos conforme disponíveis e podem mudar durante o desenvolvimento. Na medida permitida por lei, não prometemos acesso ininterrupto nem que recursos demonstrados serão lançados exatamente como descritos.",
        },
        {
          title: "7. Responsabilidade",
          body: "Nada nestes termos exclui direitos ou responsabilidades que a lei não permita excluir. Respeitado esse limite, o Quibt não responde por perdas indiretas decorrentes apenas da confiança em material de prévia ou de indisponibilidade temporária do site.",
        },
        {
          title: "8. Lei aplicável",
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

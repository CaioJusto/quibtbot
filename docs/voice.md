# Voz: ouvir as respostas dos bots

O Quibt fala em duas direções. **Ditado** já existia: o microfone do composer grava um
recado, transcrito no seu navegador (Whisper local — o áudio não sai da máquina). Esta
página é sobre a outra direção: **os bots lendo as respostas em voz alta** (TTS).

## O que você precisa

Entre com **ChatGPT Plus/Pro** em **Conta → Modelos**. É o mesmo login ChatGPT/Codex
que os bots já usam para modelos: a voz reutiliza o token OAuth cifrado no servidor,
inclusive a renovação automática. Não há campo para colar `OPENAI_API_KEY`, chave da
ElevenLabs ou outra credencial de voz, e nenhum token desce ao navegador.

O servidor chama o endpoint de fala da OpenAI com `gpt-4o-mini-tts`. Em testes com o
runtime `scripted`, o provedor é substituído por um WAV curto e nenhuma rede é aberta.

## Ligando a voz de um bot

A voz é **por bot**, nos ajustes dele:

- **Voz** — liga o botão de ouvir (🔊) que aparece ao passar o mouse numa resposta.
  Clicar de novo, enquanto toca, para.
- **Falar respostas** — lê cada resposta nova em voz alta, sem apertar nada. Junto com o
  ditado do microfone, isso já dá uma conversa de ida e volta: fale, solte, ouça.
- **Voz (opcional)** — o nome de uma voz OpenAI (`alloy`, `coral`, `fable`, `nova`…).
  Vazio usa `alloy`. Cada bot pode ter a sua — o time inteiro não precisa soar igual.

Nos grupos, cada resposta fala com a voz do bot que a escreveu.

## O que o bot fala (e o que ele pula)

Respostas são Markdown, e Markdown lido ao pé da letra é insuportável. Antes de falar:

- blocos de código viram "trecho de código" (ninguém quer ouvir um shell script);
- links e imagens ficam só com o rótulo;
- `#`, `*`, `>`, tabelas e afins saem.

Cada pedido de fala é cortado em 4.000 caracteres para uma resposta-relatório não virar
minutos de áudio sem ninguém pedir. A API também limita a 30 leituras por minuto por
cliente.

## Limites conhecidos

- Web e desktop por enquanto; o app do celular ainda não fala.
- Não há modo "chamada" contínuo (mão livre, escuta permanente). O caminho de hoje é
  ditado + falar respostas.
- O primeiro áudio depois de abrir a página pode exigir um clique (política de autoplay
  dos navegadores); o botão 🔊 sempre funciona.

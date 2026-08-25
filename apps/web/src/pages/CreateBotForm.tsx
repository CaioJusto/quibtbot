import { DEFAULT_APPEARANCE, formatAppearance, type MarkShape } from "@quibt/ui-tokens";
import { BotAvatar, CharacterPicker } from "@quibt/ui-web";
import { useState } from "react";
import { Icon } from "../components/desktop-ui";

const ROLE_STARTERS = [
  {
    title: "Operações",
    description: "Organiza prioridades, acompanha pendências e prepara o próximo passo.",
  },
  {
    title: "Pesquisa",
    description: "Busca fontes, compara caminhos e entrega sínteses objetivas.",
  },
  {
    title: "Relacionamento",
    description: "Prepara respostas, acompanha retornos e mantém conversas em dia.",
  },
];

export type CreateBotFormValues = {
  name: string;
  title: string;
  description: string;
  color: string;
  shape: MarkShape;
};

export function CreateBotForm({
  onCreate,
  onCancel,
  error,
  onPlans,
}: {
  onCreate: (input: CreateBotFormValues) => void;
  onCancel: () => void;
  error?: string | null;
  onPlans?: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(DEFAULT_APPEARANCE.color);
  const [shape, setShape] = useState<MarkShape>(DEFAULT_APPEARANCE.shape);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  return (
    <div className="qb-create-bot">
      <div className="qb-dash__subhead">
        <span className="w-[30px]" aria-hidden="true" />
        <span>Novo Bot</span>
        <button type="button" onClick={onCancel} aria-label="Fechar criação de bot">
          <Icon name="chevronRight" size={18} />
        </button>
      </div>

      <div className="qb-dash__settings-avatar">
        <button
          type="button"
          aria-label="Editar personagem"
          aria-expanded={appearanceOpen}
          onClick={() => setAppearanceOpen((open) => !open)}
        >
          <BotAvatar color={color} shape={shape} size={70} title={name || "Novo bot"} />
        </button>
        {appearanceOpen ? (
          <div className="qb-dash__character-popover">
            <CharacterPicker
              color={color}
              shape={shape}
              onChange={(next) => {
                setColor(next.color);
                setShape(next.shape);
              }}
            />
          </div>
        ) : null}
      </div>
      <div className="qb-create-bot__intro">
        <span>Personagem</span>
        <h2>Dê uma missão ao novo personagem.</h2>
        <p>
          O nome aparece nas conversas. A missão orienta como ele trabalha desde o primeiro pedido.
        </p>
        <p>Como a marca deste bot aparece em todo lugar. Toque no personagem para personalizar.</p>
      </div>
      <label className="qb-dash__field">
        Nome
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dê um nome a este bot"
        />
      </label>
      <label className="qb-dash__field">
        Cargo
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Descreva o que este bot faz"
        />
      </label>
      <label className="qb-dash__field">
        Descrição
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex.: organiza prioridades, prepara respostas e me avisa quando algo precisar de revisão"
          rows={4}
        />
      </label>

      <div className="qb-create-bot__starters">
        <span>Comece com uma função</span>
        <div>
          {ROLE_STARTERS.map((starter) => (
            <button
              key={starter.title}
              type="button"
              onClick={() => {
                setTitle(starter.title);
                setDescription(starter.description);
              }}
              className={title === starter.title ? "is-selected" : undefined}
            >
              {starter.title}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-[13px] text-[var(--qb-danger)]">
          {error}{" "}
          {onPlans ? (
            <button
              type="button"
              onClick={onPlans}
              className="font-semibold text-[var(--qb-danger)]"
            >
              Ver planos
            </button>
          ) : null}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() =>
          onCreate({
            name,
            title,
            description,
            color: formatAppearance({ color, shape }),
            shape,
          })
        }
        className="qb-routine__save mt-5 w-full disabled:opacity-40"
      >
        Criar Bot
      </button>
    </div>
  );
}

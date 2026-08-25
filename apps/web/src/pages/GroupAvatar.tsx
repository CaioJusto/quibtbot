import { BotAvatar } from "@quibt/ui-web";

export type GroupAvatarMember = { id: string; color: string; shape?: string | null };

/**
 * The group's composite mark: up to three member blobs clustered together.
 * Three members sit two-on-top, one bottom-center — not wrapped to the left.
 */
export function GroupAvatar({
  members,
  size = 38,
  className,
}: {
  members: GroupAvatarMember[];
  size?: number;
  className?: string;
}) {
  const shown = members.slice(0, 3);
  if (shown.length <= 1) {
    const member = shown[0];
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center ${className ?? ""}`}
        style={{ width: size, height: size }}
      >
        {member ? (
          <BotAvatar color={member.color} shape={member.shape} size={Math.round(size * 0.88)} />
        ) : (
          <span className="text-[var(--qb-muted)]" style={{ fontSize: Math.round(size * 0.34) }}>
            ◇
          </span>
        )}
      </span>
    );
  }

  const mark = Math.round(size * (shown.length === 2 ? 0.56 : 0.5));
  return (
    <span
      className={`relative inline-block shrink-0 ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {shown.map((member, i) => {
        const pos = clusterOffset(shown.length, i, size, mark);
        return (
          <span key={member.id} className="absolute" style={{ left: pos.x, top: pos.y }}>
            <BotAvatar color={member.color} shape={member.shape} size={mark} />
          </span>
        );
      })}
    </span>
  );
}

function clusterOffset(count: number, index: number, size: number, mark: number) {
  if (count === 2) {
    const y = Math.round((size - mark) / 2);
    return index === 0 ? { x: 0, y } : { x: size - mark, y };
  }
  if (index === 0) return { x: 0, y: 0 };
  if (index === 1) return { x: size - mark, y: 0 };
  return { x: Math.round((size - mark) / 2), y: size - mark };
}

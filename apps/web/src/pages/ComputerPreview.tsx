import type { ReactNode } from "react";

export function ComputerPreview({
  host,
  title,
  lines = [],
  imageSrc,
  imageAlt,
  children,
  bare = false,
}: {
  host: string;
  title: string;
  lines?: string[];
  imageSrc?: string;
  imageAlt?: string;
  children?: ReactNode;
  bare?: boolean;
}) {
  if (bare) {
    return (
      <div className="qb-dash__desktop is-bare">
        {children ??
          (imageSrc ? (
            <img className="qb-dash__window-image" src={imageSrc} alt={imageAlt ?? title} />
          ) : (
            <div className="qb-dash__bare-status">
              <div className="qb-dash__window-title">{title}</div>
              {lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ))}
      </div>
    );
  }

  return (
    <div className="qb-dash__desktop">
      <div className="qb-dash__window">
        <div className="qb-dash__window-bar">
          <span />
          <span />
          <span />
          <div className="qb-dash__window-url">{host}</div>
        </div>
        <div
          className={`qb-dash__window-body${
            children || imageSrc ? " min-h-[120px] flex-1 p-0" : ""
          }`}
        >
          {children ??
            (imageSrc ? (
              <img className="qb-dash__window-image" src={imageSrc} alt={imageAlt ?? title} />
            ) : (
              <>
                <div className="qb-dash__window-title">{title}</div>
                {lines.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </>
            ))}
        </div>
      </div>
    </div>
  );
}

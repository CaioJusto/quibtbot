export type ContextMenuAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ponto exato do toque, no mesmo sistema de coordenadas do retângulo medido. */
  touchX?: number;
  touchY?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Posiciona o cartão perto do dedo quando há um ponto de toque e mantém o comportamento
 * de âncora retangular para botões e linhas. O clamp final impede que menus abram fora da
 * janela quando a mensagem é maior que a própria tela.
 */
export function contextMenuPosition({
  anchor,
  menuWidth,
  menuHeight,
  screenWidth,
  screenHeight,
  alignRight = false,
  gap = 10,
  edge = 12,
}: {
  anchor: ContextMenuAnchor;
  menuWidth: number;
  menuHeight: number;
  screenWidth: number;
  screenHeight: number;
  alignRight?: boolean;
  gap?: number;
  edge?: number;
}) {
  const hasTouch = Number.isFinite(anchor.touchX) && Number.isFinite(anchor.touchY);
  const horizontalPoint = hasTouch ? (anchor.touchX as number) : null;
  const belowEdge = hasTouch ? (anchor.touchY as number) : anchor.y + anchor.height;
  const aboveEdge = hasTouch ? (anchor.touchY as number) : anchor.y;
  const roomBelow = screenHeight - edge - gap - belowEdge;
  const roomAbove = aboveEdge - edge - gap;
  const placeBelow = roomBelow >= menuHeight || (roomAbove < menuHeight && roomBelow >= roomAbove);
  const wantedTop = placeBelow ? belowEdge + gap : aboveEdge - gap - menuHeight;
  const maxTop = Math.max(edge, screenHeight - menuHeight - edge);

  const wantedLeft =
    horizontalPoint !== null
      ? horizontalPoint - menuWidth / 2
      : alignRight
        ? anchor.x + anchor.width - menuWidth
        : anchor.x + anchor.width / 2 - menuWidth / 2;
  const maxLeft = Math.max(edge, screenWidth - menuWidth - edge);

  return {
    top: clamp(wantedTop, edge, maxTop),
    left: clamp(wantedLeft, edge, maxLeft),
  };
}

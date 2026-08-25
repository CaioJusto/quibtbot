export function browserWindowOptions(platform: NodeJS.Platform) {
  const mac = platform === "darwin";
  return {
    // Uma janela de app, não um painel de monitor inteiro: 1440x900 abria ocupando
    // quase toda a tela do notebook e a landing ficava esticada demais para ler.
    width: 1160,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#05080F",
    show: true,
    autoHideMenuBar: true,
    frame: mac,
    titleBarStyle: mac ? ("hiddenInset" as const) : undefined,
    trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
  };
}

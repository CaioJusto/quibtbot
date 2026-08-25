const { contextBridge, ipcRenderer } = require("electron");

const bridge = {
  platform: process.platform,
  reloadApp: () => ipcRenderer.invoke("desktop.reloadApp"),
  startStack: () => ipcRenderer.invoke("desktop.startStack"),
  completeLocalPairing: () => ipcRenderer.invoke("desktop.completeLocalPairing"),
  connectRemote: (url) => ipcRenderer.invoke("desktop.connectRemote", url),
  forgetRemote: () => ipcRenderer.invoke("desktop.forgetRemote"),
  guidedVpsBootstrap: () => ipcRenderer.invoke("desktop.guidedVpsBootstrap"),
  remoteInstallStatus: () => ipcRenderer.invoke("desktop.remoteInstallStatus"),
  inspectSshHost: (payload) => ipcRenderer.invoke("desktop.inspectSshHost", payload),
  installOverSsh: (payload) => ipcRenderer.invoke("desktop.installOverSsh", payload),
  installOnBox: (payload) => ipcRenderer.invoke("desktop.installOnBox", payload),
  cancelRemoteInstall: (payload) => ipcRenderer.invoke("desktop.cancelRemoteInstall", payload),
  remoteSecrets: () => ipcRenderer.invoke("desktop.remoteSecrets"),
  forgetRemoteSecrets: (target) => ipcRenderer.invoke("desktop.forgetRemoteSecrets", target),
  startupNotice: () => ipcRenderer.invoke("desktop.startupNotice"),
  uninstall: () => ipcRenderer.invoke("desktop.uninstall"),
  onInstallEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("desktop.installEvent", listener);
    return () => ipcRenderer.removeListener("desktop.installEvent", listener);
  },
  onInstallPairing: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("desktop.installPairing", listener);
    return () => ipcRenderer.removeListener("desktop.installPairing", listener);
  },
  lanInfo: () => ipcRenderer.invoke("desktop.lanInfo"),
  remoteAccess: (enabled) => ipcRenderer.invoke("desktop.remoteAccess", { enabled }),
  grantFolder: () => ipcRenderer.invoke("desktop.grantFolder"),
  listGrants: () => ipcRenderer.invoke("desktop.listGrants"),
  readGranted: (filePath) => ipcRenderer.invoke("desktop.readGranted", filePath),
  writeGranted: (filePath, content) =>
    ipcRenderer.invoke("desktop.writeGranted", filePath, content),
  window: {
    close: () => ipcRenderer.invoke("desktop.window.close"),
    minimize: () => ipcRenderer.invoke("desktop.window.minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop.window.toggleMaximize"),
    state: () => ipcRenderer.invoke("desktop.window.state"),
  },
};

contextBridge.exposeInMainWorld("quibtDesktop", bridge);

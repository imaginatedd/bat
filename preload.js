const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    loadVST3: (path) => ipcRenderer.invoke('load-vst3', path),
    processVST3: (pluginId, audioData) => ipcRenderer.invoke('process-vst3', pluginId, audioData),
    unloadVST3: (pluginId) => ipcRenderer.invoke('unload-vst3', pluginId),
    getVST3Parameters: (pluginId) => ipcRenderer.invoke('get-vst3-params', pluginId),
    setVST3Parameter: (pluginId, paramId, value) => ipcRenderer.invoke('set-vst3-param', pluginId, paramId, value),
    openVST3Dialog: () => ipcRenderer.invoke('open-vst3-dialog'),
    getWorkletSource: () => ipcRenderer.invoke('get-worklet-source')
});

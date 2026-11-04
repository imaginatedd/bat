const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let vstPlugins = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'Virtual Audio Cable',
    backgroundColor: '#1a1a1a'
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools();
}

// VST3 Plugin Management (placeholder for native implementation)
ipcMain.handle('open-vst3-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load VST3 Plugin',
    filters: [
      { name: 'VST3 Plugins', extensions: ['vst3'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('load-vst3', async (event, pluginPath) => {
  try {
    // Check if file exists
    if (!fs.existsSync(pluginPath)) {
      throw new Error('Plugin file not found');
    }

    const pluginId = `vst3_${Date.now()}`;
    const pluginName = path.basename(pluginPath, '.vst3');

    // Store plugin info (in production, this would load the actual VST3)
    vstPlugins.set(pluginId, {
      path: pluginPath,
      name: pluginName,
      parameters: []
    });

    return {
      success: true,
      pluginId,
      name: pluginName,
      message: 'VST3 plugin loaded successfully'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('process-vst3', async (event, pluginId, audioData) => {
  const plugin = vstPlugins.get(pluginId);
  if (!plugin) {
    return { success: false, error: 'Plugin not found' };
  }
  // Placeholder: real VST3 processing requires a native addon.
  // Audio is passed through unchanged for now.
  return { success: true, audioData };
});

ipcMain.handle('unload-vst3', async (event, pluginId) => {
  if (vstPlugins.has(pluginId)) {
    vstPlugins.delete(pluginId);
    return { success: true };
  }
  return { success: false, error: 'Plugin not found' };
});

ipcMain.handle('get-vst3-params', async (event, pluginId) => {
  const plugin = vstPlugins.get(pluginId);
  if (plugin) {
    return { success: true, parameters: plugin.parameters };
  }
  return { success: false, error: 'Plugin not found' };
});

ipcMain.handle('set-vst3-param', async (event, pluginId, paramId, value) => {
  const plugin = vstPlugins.get(pluginId);
  if (plugin) {
    // In production, this would set the actual VST3 parameter
    return { success: true };
  }
  return { success: false, error: 'Plugin not found' };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  vstPlugins.clear();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

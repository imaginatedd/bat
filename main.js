const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;
let vstPlugins = new Map(); // pluginId -> { name, path, host, parameters }

// --- Native VST3 host bridge ----------------------------------------------
// One host process per loaded plugin. The host speaks a line protocol:
//   load\t<path> | get\t<id> | set\t<id>\t<value> | unload | quit
// Responses are single JSON lines.
class Vst3Host {
  constructor() {
    this.proc = null;
    this._waiters = [];
    this._buf = '';
    this.params = [];
  }

  spawn(hostPath) {
    return new Promise((resolve, reject) => {
      this.proc = spawn(hostPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      let settled = false;
      this.proc.once('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      this.proc.once('spawn', () => {
        if (!settled) { settled = true; resolve(); }
      });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', () => { /* ignore */ });
      this.proc.on('exit', (code) => {
        this._failAll(new Error('VST3 host exited (code ' + code + ')'));
        this.proc = null;
      });
    });
  }

  _onData(d) {
    this._buf += d;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { msg = { type: 'error', message: 'Invalid host response' }; }
      const w = this._waiters.shift();
      if (w) w.resolve(msg);
    }
  }

  _failAll(err) {
    while (this._waiters.length) this._waiters.shift().reject(err);
  }

  send(line) {
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
      this.proc.stdin.write(line + '\n');
    });
  }

  async load(pluginPath) {
    const msg = await this.send('load\t' + pluginPath);
    if (msg.type === 'error') throw new Error(msg.message);
    this.params = msg.params || [];
    return this.params;
  }

  async setParam(paramId, value) {
    const msg = await this.send('set\t' + paramId + '\t' + value);
    if (msg.type === 'error') throw new Error(msg.message);
    return msg.value;
  }

  async getParam(paramId) {
    const msg = await this.send('get\t' + paramId);
    if (msg.type === 'error') throw new Error(msg.message);
    return msg.value;
  }

  async unload() {
    try { await this.send('unload'); } catch (e) { /* ignore */ }
  }

  kill() {
    if (this.proc) {
      try { this.proc.stdin.write('quit\n'); } catch (e) { /* ignore */ }
      try { this.proc.kill(); } catch (e) { /* ignore */ }
      this.proc = null;
    }
  }
}

function getHostPath() {
  return path.join(__dirname, 'native', 'build', 'Release', 'vst3_host.exe');
}

function killAllHosts() {
  for (const plugin of vstPlugins.values()) {
    try { plugin.host.kill(); } catch (e) { /* ignore */ }
  }
  vstPlugins.clear();
}

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

// Serve the AudioWorklet module source so the renderer can load it as a Blob
// URL (avoids file:// module-loading restrictions for AudioWorklet).
ipcMain.handle('get-worklet-source', () => {
  return fs.readFileSync(path.join(__dirname, 'noise-gate-processor.js'), 'utf8');
});

// --- VST3 plugin management -----------------------------------------------

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
    if (!pluginPath || !fs.existsSync(pluginPath)) {
      throw new Error('Plugin file not found');
    }

    const hostPath = getHostPath();
    if (!fs.existsSync(hostPath)) {
      throw new Error(
        'VST3 host binary not found. Build it first (see native/README.md).\n' +
        'Expected: ' + hostPath
      );
    }

    const host = new Vst3Host();
    await host.spawn(hostPath);
    const parameters = await host.load(pluginPath);

    const pluginId = 'vst3_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const pluginName = path.basename(pluginPath, '.vst3');

    vstPlugins.set(pluginId, {
      name: pluginName,
      path: pluginPath,
      host,
      parameters
    });

    return {
      success: true,
      pluginId,
      name: pluginName,
      parameters
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('process-vst3', async (event, pluginId, audioData) => {
  const plugin = vstPlugins.get(pluginId);
  if (!plugin) {
    return { success: false, error: 'Plugin not found' };
  }
  // Real-time audio processing through the plugin is not wired up yet;
  // pass the buffer through unchanged.
  return { success: true, audioData };
});

ipcMain.handle('unload-vst3', async (event, pluginId) => {
  const plugin = vstPlugins.get(pluginId);
  if (!plugin) {
    return { success: false, error: 'Plugin not found' };
  }
  try { await plugin.host.unload(); } catch (e) { /* ignore */ }
  plugin.host.kill();
  vstPlugins.delete(pluginId);
  return { success: true };
});

ipcMain.handle('get-vst3-params', async (event, pluginId) => {
  const plugin = vstPlugins.get(pluginId);
  if (!plugin) {
    return { success: false, error: 'Plugin not found' };
  }
  return { success: true, parameters: plugin.parameters };
});

ipcMain.handle('set-vst3-param', async (event, pluginId, paramId, value) => {
  const plugin = vstPlugins.get(pluginId);
  if (!plugin) {
    return { success: false, error: 'Plugin not found' };
  }
  try {
    const v = await plugin.host.setParam(paramId, value);
    const p = plugin.parameters.find((pp) => pp.id === paramId);
    if (p) p.value = v;
    return { success: true, value: v };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killAllHosts();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllHosts();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

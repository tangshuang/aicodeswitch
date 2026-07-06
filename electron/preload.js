/**
 * Electron preload：在隔离的渲染层（loading.html）暴露受控的 IPC 接收 API。
 * 仅暴露 onStartupLog / onStartupError 两个只读监听器，不开放任何 Node 能力。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aicodeswitch', {
  onStartupLog: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('startup-log', listener);
    return () => ipcRenderer.removeListener('startup-log', listener);
  },
  onStartupError: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('startup-error', listener);
    return () => ipcRenderer.removeListener('startup-error', listener);
  },
});

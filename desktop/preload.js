// Ponte mínima entre as páginas do app e o processo principal (sem expor Node às páginas).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uvozDesktop', {
  isDesktop: true,
  // Usados só pelo seletor de tela (picker.html); o processo principal ignora chamadas de outras páginas.
  listSources: () => ipcRenderer.invoke('picker:sources'),
  chooseSource: (choice) => ipcRenderer.send('picker:choose', choice),
});

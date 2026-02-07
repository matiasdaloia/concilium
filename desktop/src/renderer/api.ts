import type { ElectronAPI } from '../preload/preload';

export const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

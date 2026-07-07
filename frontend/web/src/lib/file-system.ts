const DB_NAME = 'patrick-im';
const STORE_NAME = 'handles';
const RECEIVE_DIR_KEY = 'receive-directory';

export type DirectoryPermissionState = 'unsupported' | 'not-configured' | 'ready' | 'needs-permission';

export interface StoredDirectoryState {
  handle: FileSystemDirectoryHandle | null;
  status: DirectoryPermissionState;
  name: string;
}

function emptyDirectoryState(status: DirectoryPermissionState): StoredDirectoryState {
  return { handle: null, status, name: '' };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'));
  });
}

async function readHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_read_failed'));
  });
}

async function writeHandle(key: string, handle: FileSystemDirectoryHandle | null): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = handle ? store.put(handle, key) : store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('indexeddb_write_failed'));
  });
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function loadReceiveDirectoryState(): Promise<StoredDirectoryState> {
  if (!supportsDirectoryPicker()) {
    return emptyDirectoryState('unsupported');
  }
  const handle = await readHandle(RECEIVE_DIR_KEY);
  if (!handle) {
    return emptyDirectoryState('not-configured');
  }
  const permission = await handle.queryPermission({ mode: 'readwrite' });
  return {
    handle,
    status: permission === 'granted' ? 'ready' : 'needs-permission',
    name: handle.name,
  };
}

export async function pickReceiveDirectory(): Promise<StoredDirectoryState> {
  if (!supportsDirectoryPicker()) {
    return emptyDirectoryState('unsupported');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const permission = await handle.requestPermission({ mode: 'readwrite' });
  await writeHandle(RECEIVE_DIR_KEY, handle);
  return {
    handle,
    status: permission === 'granted' ? 'ready' : 'needs-permission',
    name: handle.name,
  };
}

export async function clearReceiveDirectory(): Promise<void> {
  await writeHandle(RECEIVE_DIR_KEY, null);
}

export async function ensureDirectoryWritable(
  state: StoredDirectoryState,
): Promise<FileSystemDirectoryHandle | null> {
  const handle = state.handle;
  if (!handle) {
    return null;
  }
  const permission = await handle.queryPermission({ mode: 'readwrite' });
  return permission === 'granted' ? handle : null;
}

export async function createWritableFile(
  handle: FileSystemDirectoryHandle,
  fileName: string,
): Promise<{
  fileHandle: FileSystemFileHandle;
  writer: FileSystemWritableFileStream;
}> {
  const safeName = sanitizeFileName(fileName || 'file');
  const availableName = await nextAvailableFileName(handle, safeName);
  const fileHandle = await handle.getFileHandle(availableName, { create: true });
  const writer = await fileHandle.createWritable();
  return { fileHandle, writer };
}

async function nextAvailableFileName(handle: FileSystemDirectoryHandle, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? fileName : `${base} (${index})${extension}`;
    if (!(await fileExists(handle, candidate))) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}${extension}`;
}

async function fileExists(handle: FileSystemDirectoryHandle, fileName: string): Promise<boolean> {
  try {
    await handle.getFileHandle(fileName);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return false;
    }
    throw error;
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
}

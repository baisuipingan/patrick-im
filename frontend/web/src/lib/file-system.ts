const DB_NAME = 'patrick-im';
const STORE_NAME = 'handles';
const RECEIVE_DIR_KEY = 'receive-directory';

type DirectoryPermissionState = 'unsupported' | 'not-configured' | 'ready' | 'needs-permission';

interface StoredDirectoryState {
  handle: FileSystemDirectoryHandle | null;
  status: DirectoryPermissionState;
  name: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
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
    return {
      handle: null,
      status: 'unsupported',
      name: '',
    };
  }

  const handle = await readHandle(RECEIVE_DIR_KEY);
  if (!handle) {
    return {
      handle: null,
      status: 'not-configured',
      name: '',
    };
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
    return {
      handle: null,
      status: 'unsupported',
      name: '',
    };
  }

  const handle = await window.showDirectoryPicker({
    mode: 'readwrite',
  });
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
  handle: FileSystemDirectoryHandle | null,
): Promise<FileSystemDirectoryHandle | null> {
  if (!handle) {
    return null;
  }

  const permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission === 'granted') {
    return handle;
  }

  return null;
}

export async function createWritableFile(
  handle: FileSystemDirectoryHandle,
  fileName: string,
): Promise<{
  fileHandle: FileSystemFileHandle;
  writer: FileSystemWritableFileStream;
}> {
  const fileHandle = await handle.getFileHandle(fileName, {
    create: true,
  });
  const writer = await fileHandle.createWritable();
  return {
    fileHandle,
    writer,
  };
}

export type { DirectoryPermissionState, StoredDirectoryState };

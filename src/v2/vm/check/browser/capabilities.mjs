// Passive platform inventory, never authority or a request for user permission.
export function inspectCapabilities(scope) {
  const navigator = scope.navigator ?? {};
  const entry = (present, permission) => ({
    api: present ? 'available-unprobed' : 'unavailable',
    permission,
    connection: 'not-connected',
  });
  return {
    opfs: entry(typeof navigator.storage?.getDirectory === 'function', 'origin-storage'),
    opfsSync: entry(typeof scope.FileSystemSyncAccessHandle === 'function', 'dedicated-worker'),
    persistentStorage: entry(typeof navigator.storage?.persist === 'function', 'not-requested'),
    storageEstimate: entry(typeof navigator.storage?.estimate === 'function', 'unprobed'),
    filePicker: entry(typeof scope.showOpenFilePicker === 'function', 'user-action-required'),
    directoryPicker: entry(typeof scope.showDirectoryPicker === 'function', 'user-action-required'),
    fileExchange: entry(typeof scope.File === 'function' && typeof scope.Blob === 'function', 'user-selection-required'),
    webTransport: entry(typeof scope.WebTransport === 'function', 'workspace-and-gateway-grant-required'),
    webLocks: entry(typeof navigator.locks?.request === 'function', 'origin-local-only'),
    serviceWorker: entry('serviceWorker' in navigator, 'not-registered-by-probe'),
    clipboard: entry(typeof navigator.clipboard?.writeText === 'function', 'user-action-and-policy-required'),
    serial: entry(typeof navigator.serial?.requestPort === 'function', 'user-selection-required'),
    usb: entry(typeof navigator.usb?.requestDevice === 'function', 'user-selection-required'),
    hid: entry(typeof navigator.hid?.requestDevice === 'function', 'user-selection-required'),
    media: entry(typeof navigator.mediaDevices?.getUserMedia === 'function', 'user-permission-required'),
    gpu: entry(typeof navigator.gpu?.requestAdapter === 'function', 'adapter-unprobed'),
  };
}

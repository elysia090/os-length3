// Keep the shared bundle linkable, including the Node-only guest entry Vite
// analyzes. None of these Node worker capabilities are available in a browser.
export const parentPort = undefined;
export const Worker = undefined;
export const workerData = undefined;

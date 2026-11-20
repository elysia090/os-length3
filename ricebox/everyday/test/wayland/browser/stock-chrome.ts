// Verify the installed browser's own Linux sandbox report in a separate context.
// The product fixture then launches the same executable in a fresh process.

export function linuxSandboxReport(rows: readonly (readonly [string, string])[]) {
  const values = new Map(rows);
  if (rows.length !== values.size) throw new Error('Ambiguous Chrome sandbox report');
  // Newer Chrome reports Layer 1 in one row; older Chrome has separate rows.
  const layer = values.get('Layer 1 Sandbox') ??
    (values.get('Namespace Sandbox') === 'Yes' ? 'Namespace' :
      values.get('SUID Sandbox') === 'Yes' ? 'SUID' : 'None');
  const pid = values.get('PID namespaces'), network = values.get('Network namespaces');
  const seccomp = values.get('Seccomp-BPF sandbox');
  const report = {layer, pid, network, seccomp};
  if ((layer !== 'Namespace' && layer !== 'SUID') ||
      pid !== 'Yes' || network !== 'Yes' || seccomp !== 'Yes') {
    throw new Error('Stock Chrome sandbox is unavailable: ' + JSON.stringify(report));
  }
  return report;
}

if (import.meta.main) {
  const {chromium} = await import('@playwright/test');
  const executablePath = process.env.EVERYDAY_CHROME_BIN;
  if (!executablePath) throw new Error('Set EVERYDAY_CHROME_BIN to the runner’s installed Chrome');
  // Cold starts vary across stock runner images. Only the launch budget changes.
  const launchTimeoutMs = 30_000;
  const launchStarted = performance.now();
  const browser = await chromium.launch({
    executablePath, headless: true, chromiumSandbox: true, timeout: launchTimeoutMs,
  }).catch((error: unknown) => {
    console.error('EVERYDAY_STOCK_CHROME_LAUNCH_FAILED',
      {elapsedMs: Math.round(performance.now() - launchStarted), timeoutMs: launchTimeoutMs});
    throw error;
  });
  try {
    console.log('EVERYDAY_STOCK_CHROME_LAUNCH_READY', {elapsedMs: Math.round(performance.now() - launchStarted)});
    const page = await browser.newPage();
    await page.goto('chrome://sandbox/', {timeout: 8000});
    await page.getByText('Seccomp-BPF sandbox', {exact: true}).waitFor({timeout: 4000});
    const rows = await page.locator('#sandbox-status tr').evaluateAll(elements => elements.map(element => {
      const cells = (element as HTMLTableRowElement).cells;
      return [cells[0]?.textContent?.trim() ?? '', cells[1]?.textContent?.trim() ?? ''] as const;
    }));
    console.log('EVERYDAY_STOCK_CHROME_SANDBOX', browser.version(), linuxSandboxReport(rows));
  } finally { await browser.close(); }
}

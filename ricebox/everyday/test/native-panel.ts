// Offline proof fixture, not a launcher or installed everyday interface.
// Print one panel for one literal connector; never discover or contact a display.
export {};
const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(output) || /^all$/i.test(output)) {
  console.error('usage: node ricebox/everyday/test/native-panel.ts CONNECTOR (one literal name, e.g. eDP-1)');
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({
    output, layer: 'top', position: 'top', exclusive: false, passthrough: true, ipc: false,
    'modules-left': [], 'modules-center': ['clock'], 'modules-right': [],
    clock: {format: '{:%H:%M}', tooltip: false},
  }, null, 2));
}

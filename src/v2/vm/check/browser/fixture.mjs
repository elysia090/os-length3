// Tiny ABI fixture, not an x86 implementation or a Linux boot substitute.
const text = value => [...new TextEncoder().encode(value)];
const name = value => [text(value).length, ...text(value)];
const section = (kind, bytes) => [kind, bytes.length, ...bytes];

export const fixture = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [1, 0x60, 2, 0x7f, 0x7e, 1, 0x7e]),
  ...section(2, [2,
    ...name('machine'), ...name('memory'), 2, 0, 1,
    ...name('machine'), ...name('table'), 1, 0x70, 1, 2, 8,
  ]),
  ...section(3, [1, 0]),
  ...section(7, [1, ...name('cut'), 0, 0]),
  ...section(9, [1, 0, 0x41, 1, 0x0b, 1, 0]),
  ...section(10, [1, 17, 0,
    0x20, 0, 0x20, 1, 0x37, 3, 0,
    0x20, 0, 0x29, 3, 0, 0x42, 1, 0x7c, 0x0b,
  ]),
]);

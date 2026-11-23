// Contract for the pinned cooperative C guest, not Quickshell or a production UI.
export const head='28c45a65649b1058da0ad5077624e8fd4fa3cee9';
export const presenter='4e5dd5650f2ba7bf606ea33c8815fb0f28df32cc9cff5d90efe7097ef11ef88d';
export const framePins=[
  'bfcba5ab878047c64dbef10ba8f4bca1fe083b858900e41ed47abb0ac11e59d1',
  '882ac2b1657741f5354fc74f2191ab33c097875fa5fbb0b8994b5018d51051d8',
  '49381ec31bd809ba282b9ef407d5fd7cc774e58b0dfa325210a464d0578c0586',
];
export const protocol=[
  'WAYLAND_COMMIT seq=1 size=32x24 configure=1 pointer=0 stride=140',
  'WAYLAND_COMMIT seq=2 size=32x24 configure=1 pointer=3 stride=140',
  'WAYLAND_COMMIT seq=3 size=47x19 configure=5 pointer=3 stride=200',
  'WAYLAND_CLIENT pointer=1 configure=2 frame_done=3 releases=3',
  'WAYLAND_WINDOW_CLOSED',
];

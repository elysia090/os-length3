import {expect, test} from '@playwright/test';

test('the opt-in screen fits its viewport and the real foreground shell observes WINCH', async ({page}) => {
  test.skip(!process.env.EVERYDAY_SHELL_ELF, 'requires the explicitly staged static BusyBox');
  await page.setViewportSize({width: 920, height: 800});
  await page.goto('/?terminal=screen&terminalResize=fit');
  const shell = page.getByRole('region', {name: 'Guest shell'});
  const status = shell.getByRole('status');
  const input = shell.getByRole('textbox', {name: 'Shell command'});
  const output = shell.locator('#shell-output');
  const canvas = page.locator('canvas');
  const grid = () => output.getAttribute('data-grid');
  const terminalSize = (value: string) => value.split('x').reverse().join(' ');
  const measuredGrid = () => output.evaluate(el => {
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    const cell = el.querySelector('.vt-measure')!.getBoundingClientRect();
    const cols = Math.floor((box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / cell.width);
    const rows = Math.floor((box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / cell.height);
    return cols + 'x' + rows;
  });
  const type = async (command: string) => { await input.fill(command); await input.press('Enter'); };
  await expect(canvas).toHaveAttribute('data-sequence', '1');
  await shell.getByRole('button', {name: 'Open guest shell'}).click();
  await expect(status).toHaveAttribute('data-phase', 'input');
  const first = await measuredGrid();
  expect(first).not.toBe('80x24');
  await expect.poll(grid).toBe(first);
  const probe = [
    'trap \'printf "<winch:%s>\\n" "$(/bin/busybox stty size)"\' WINCH',
    'printf "<probe:%s>\\n" "$(/bin/busybox stty size)"',
    'while :; do if IFS= read -r line; then',
    '  case "$line" in',
    '    stop) break;;',
    '    *) printf "<read:%s>\\n" "$line";;',
    '  esac',
    'fi; done',
  ].join('\n');
  // A foreground process whose WINCH behavior we own, not the interactive
  // Ash line editor (which can install its own handler at a prompt).
  await type("/bin/busybox sh -c '" + probe.replaceAll("'", "'\\''") + "'");
  await expect(output).toContainText('<probe:' + terminalSize(first) + '>');
  await expect(status).toHaveAttribute('data-phase', 'input');
  await expect(input).toBeFocused();

  await page.setViewportSize({width: 624, height: 635});
  const after = await measuredGrid();
  await expect.poll(grid).toBe(after);
  const [cols, rows] = after.split('x').map(Number);
  expect(cols).toBeLessThan(Number(first.split('x')[0]));
  expect(rows).toBeLessThan(Number(first.split('x')[1]));
  await expect(output.locator('.vt-row')).toHaveCount(rows!);
  await expect(output).toContainText('<winch:' + terminalSize(after) + '>');
  await expect(status).toHaveAttribute('data-phase', 'input');
  await expect(input).toBeFocused();
  await expect(canvas).toHaveAttribute('data-sequence', '1');
  await expect(canvas).toHaveAttribute('width', '32');
  await expect(canvas).toHaveAttribute('height', '24');
  await expect.poll(async () => (await output.innerText()).match(/<winch:\d+ \d+>/g)?.length).toBe(1);

  await type('still-reading');
  await expect(output).toContainText('<read:still-reading>');
  await expect(status).toHaveAttribute('data-phase', 'input');
  await type('stop');
  // Distinguish the responsive child from the interactive parent before exit.
  await expect(output).toContainText(/<read:still-reading>[\s\S]+everyday\$/);
  await expect(status).toHaveAttribute('data-phase', 'input');
  await type('exit');
  await expect(status).toHaveText('Shell admission closed');
  await expect(output.locator('.vt-measure')).toHaveCount(0);
  await page.setViewportSize({width: 880, height: 710});
  await expect(output).toHaveAttribute('data-grid', after);
  await expect(input).toBeDisabled();
  await expect(canvas).toHaveAttribute('data-sequence', '1');
});

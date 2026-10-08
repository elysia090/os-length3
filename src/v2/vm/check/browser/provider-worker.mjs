// Diagnostic input construction only: all guest reads/translation execute in
// C vm.wasm. This test driver is not a guest instruction scheduler or broker.
self.onmessage = async ({ data: { generation } }) => {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    expect(generation === 9, 'unexpected diagnostic generation');
    const root = new URL('./generated/', import.meta.url);
    const response = await fetch(new URL('manifest.json', root));
    expect(response.ok, 'run prepare-browser-provider.mjs before opening this probe');
    const manifest = await response.json();
    expect(manifest.format === 'c-provider-diagnostic-v3' && manifest.linuxBoot === 'not-tested', 'diagnostic manifest');
    async function fetchFixture(name) {
      const reply = await fetch(new URL(name, root));
      expect(reply.ok, `missing ${name}`);
      if (name.endsWith('.wasm')) expect(reply.headers.get('content-type') === 'application/wasm', 'Wasm MIME');
      const bytes = await reply.arrayBuffer(), record = manifest.files[name];
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
      expect(bytes.byteLength === record.bytes && hex === record.sha256, `stale/corrupt ${name}`);
      return bytes;
    }
    // The diagnostic manifest only detects stale/corrupt local fixture serving.
    // It is not a signed production root or proof of executable admission.
    const [providerBytes, referenceCut, caseBytes, metaBytes, codePage, compilerBytes] = await Promise.all(
      ['vm.wasm', 'cut.wasm', 'cases.bin', 'cut.json', 'source-page.bin', 'wasm-compiler.wasm'].map(fetchFixture));
    const provider = await WebAssembly.compile(providerBytes);
    expect(JSON.stringify(WebAssembly.Module.imports(provider)) === JSON.stringify([
      { module: 'machine', name: 'memory', kind: 'memory' },
    ]), 'C provider must not import host guest-memory semantics');
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)), records = new DataView(caseBytes);
    expect(Number.isInteger(meta.operandBinding) && meta.operandBinding>=0
      && meta.operandBinding<=0xffffffff,'explicit cold scalar binding');
    expect(meta.bytes === 8 && meta.access === 1 && meta.sourceBytes > 0
      && codePage.byteLength === 4096 && caseBytes.byteLength === 512 * 38 * 8, 'native record extent');
    let generated;
    {
      const compilerModule = await WebAssembly.compile(compilerBytes);
      expect(JSON.stringify(WebAssembly.Module.imports(compilerModule)) === JSON.stringify([
        {module:'machine',name:'memory',kind:'memory'},
      ]), 'cold compiler has no WASI/host decoder');
      // Separate cold memory: independently linked C data/stack must not
      // overwrite the VM's static data. Only the derived module escapes.
      const coldMemory = new WebAssembly.Memory({initial:16,maximum:32});
      const compiler = (await WebAssembly.instantiate(compilerModule,{machine:{memory:coldMemory}})).exports;
      expect(compiler.compiler_entry_abi()===4,'regenerate old compiler/fixtures, not an ABI adapter');
      const input = compiler.compiler_arena_min(), output = input + 8192, report = output + 65536;
      expect(report + compiler.compiler_report_bytes() <= coldMemory.buffer.byteLength,'bounded cold arena');
      new Uint8Array(coldMemory.buffer,input,4096).set(new Uint8Array(codePage));
      expect(compiler.compiler_open_pages(input,1,BigInt(meta.entry) & ~4095n,9n) === 0,'cold borrowed code admission');
      expect(compiler.compiler_emit(BigInt(meta.entry),1,output,65536,report) === 0,'C-Wasm cut construction');
      const bytes = Number(new DataView(coldMemory.buffer).getBigUint64(report + 40,true));
      expect(new DataView(coldMemory.buffer).getUint32(report+76,true)===meta.operandBinding,
        'native / cold-Wasm operand attestation');
      generated = new Uint8Array(coldMemory.buffer,output,bytes).slice();
      const expected = new Uint8Array(referenceCut);
      expect(generated.length === expected.length && generated.every((byte,rank) => byte === expected[rank]),
        'cold Wasm / native C emitted bytes');
      compiler.compiler_close();
    }
    const cut = await WebAssembly.compile(generated);
    const memory = new WebAssembly.Memory({ initial: 8, maximum: 16 });
    const vm = (await WebAssembly.instantiate(provider, { machine: { memory } })).exports;
    const instance = await WebAssembly.instantiate(cut, { machine: { memory, access: vm.vm_access } });
    expect(vm.vm_entry_abi()===4 && instance.exports.cut.length===4,'uniform typed table');
    const directory = vm.vm_arena_min(), base = directory + 4096, port = base + 2048;
    const cutRow = directory + 512, entry = BigInt(meta.entry);
    const table = vm.__indirect_function_table, slot = table.grow(1);
    expect(slot >= vm.vm_slot_min(), 'guest slot must not replace private C callbacks');
    table.set(slot, instance.exports.cut);
    const shifts = [39n, 30n, 21n, 12n];
    function page(view, rank, address, offset) {
      const at = directory + rank * 32;
      view.setBigUint64(at, address, true); view.setUint32(at + 8, offset, true);
      view.setUint32(at + 12, 3, true); view.setUint32(at + 16, 1, true);
      view.setUint32(at + 20, 0, true); view.setUint32(at + 24, 0, true);
    }
    let comparisons = 0;
    for (let row = 0; row < 512; ++row) {
      if (row === 256) memory.grow(1);
      const arena = new Uint8Array(memory.buffer, base); arena.fill(0);
      const view = new DataView(memory.buffer), word = rank => records.getBigUint64((row * 38 + rank) * 8, true);
      for (let reg = 0; reg < 16; ++reg) view.setBigUint64(base + reg * 8, word(reg), true);
      view.setBigUint64(base + meta.ripOffset, BigInt(meta.entry), true);
      view.setBigUint64(base + meta.flagsOffset, word(16), true);
      view.setBigUint64(base + meta.retiredOffset, 42n, true);
      view.setBigUint64(base + 400, 0x80010001n, true); view.setBigUint64(base + 408, 0x1000n, true);
      view.setBigUint64(base + 416, 32n, true); view.setBigUint64(base + 424, 0xd00n, true);
      view.setBigUint64(base + 488, 0x10n, true); view.setBigUint64(port, 9n, true);
      const address = word(35);
      for (let level = 0; level < 4; ++level) {
        page(view, level, BigInt((level + 1) * 4096), (level + 2) * 4096);
        const at = base + (level + 2) * 4096 + Number((address >> shifts[level]) & 511n) * 8;
        view.setBigUint64(at, BigInt(level === 3 ? 0x8000 : (level + 2) * 4096) | 103n, true);
      }
      const leaf = base + 20480 + Number((address >> 12n) & 511n) * 8;
      view.setBigUint64(leaf + 8, 0x9067n, true);
      expect((address >> 39n) !== (entry >> 39n), 'this fixture uses distinct top-level branches');
      const offsets = [8192, 32768, 36864, 45056];
      for (let level = 1; level < 4; ++level)
        page(view, level + 3, BigInt((level + 4) * 4096), offsets[level]);
      for (let level = 0; level < 4; ++level) {
        const at = base + offsets[level] + Number((entry >> shifts[level]) & 511n) * 8;
        view.setBigUint64(at, BigInt(level === 3 ? 0xa000 : (level + 5) * 4096) | 103n, true);
      }
      page(view, 7, 0x8000n, 28672); page(view, 8, 0x9000n, 40960);
      page(view, 9, 0xa000n, 49152); arena.set(new Uint8Array(codePage), 49152);
      view.setBigUint64(cutRow, entry, true); view.setUint32(cutRow + 8, meta.sourceBytes, true);
      view.setUint32(cutRow + 12, 1, true); view.setUint32(cutRow + 16, slot, true); view.setUint32(cutRow + 20, meta.operandBinding, true);
      for (let i = 0; i < 8; ++i) {
        const offset = Number(address & 4095n) + i;
        view.setUint8(base + (offset < 4096 ? 28672 + offset : 40960 + offset - 4096),
          Number((word(36) >> BigInt(i * 8)) & 255n));
      }
      expect(vm.vm_open(base,memory.buffer.byteLength - base,4096,directory,10,10,directory + 1024,9n) === 0, 'resident admission');
      expect(vm.vm_bind_state(base) === 0 && vm.vm_bind_execution(cutRow, 1, 9n) === 0, 'compiled execution admission');
      expect(vm.vm_run(port, 9n, 1) === 1n && vm.vm_completed() === 1
        && vm.vm_source_retired() === 1n, 'actual C dispatcher/MMU cut');
      for (let reg = 0; reg < 16; ++reg)
        expect(view.getBigUint64(base + reg * 8, true) === word(17 + reg), `native GPR ${reg} row ${row}`);
      expect(view.getBigUint64(base + meta.flagsOffset, true) === word(33), 'native flags');
      expect(view.getBigUint64(base + meta.ripOffset, true) === word(34), 'native continuation');
      expect(view.getBigUint64(base + meta.retiredOffset, true) === 43n, 'single retirement');
      ++comparisons;
    }
    table.set(slot, null); vm.vm_close();
    self.postMessage({ format: 'browser-c-provider-probe-v3', status: 'pass', linuxBoot: 'not-tested',
      secureContext: self.isSecureContext, isolated: self.crossOriginIsolated, generation,
      comparisons, modules: 1, providerBytes: providerBytes.byteLength,
      compilerBytes: compilerBytes.byteLength, coldCompilation: 'C-Wasm decoder/planner/emitter',
      guestMemoryCallback: 'C-Wasm function, not JavaScript',
      guestExecution: 'C-Wasm table dispatcher', memoryBytes: memory.buffer.byteLength });
  } catch (error) {
    self.postMessage({ format: 'browser-c-provider-probe-v3', status: 'fail', linuxBoot: 'not-tested', error: String(error) });
  }
};

// Locate one exported function body without compiling the WebAssembly module.

function bytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  return value;
}

function cursor(source) {
  let at = 0;
  const need = (count) => {
    if (!Number.isSafeInteger(count) || count < 0 || at + count > source.length) {
      throw new Error('WebAssembly module is truncated');
    }
  };
  const byte = () => {
    need(1);
    return source[at++];
  };
  const u32 = () => {
    let value = 0;
    let shift = 0;
    for (let count = 0; count < 5; count += 1) {
      const part = byte();
      if (count === 4 && (part & 0xf0)) {
        throw new Error('WebAssembly u32 is out of range');
      }
      value += (part & 0x7f) * (2 ** shift);
      if (!(part & 0x80)) return value;
      shift += 7;
    }
    throw new Error('WebAssembly u32 is malformed');
  };
  const name = () => {
    const length = u32();
    need(length);
    const value = new TextDecoder('utf-8', { fatal: true })
      .decode(source.subarray(at, at + length));
    at += length;
    return value;
  };
  const skip = (count) => {
    need(count);
    at += count;
  };
  return {
    byte, u32, name, skip,
    get at() { return at; },
    set at(value) {
      if (!Number.isSafeInteger(value) || value < at || value > source.length) {
        throw new Error('WebAssembly section extent is invalid');
      }
      at = value;
    },
  };
}

function skipLimits(reader) {
  const flags = reader.u32();
  reader.u32();
  if (flags & 1) reader.u32();
}

function importedFunctionCount(source, start, end) {
  const reader = cursor(source);
  reader.at = start;
  const count = reader.u32();
  let functions = 0;
  for (let index = 0; index < count; index += 1) {
    reader.name();
    reader.name();
    const kind = reader.byte();
    if (kind === 0) {
      reader.u32();
      functions += 1;
    } else if (kind === 1) {
      reader.byte();
      skipLimits(reader);
    } else if (kind === 2) {
      skipLimits(reader);
    } else if (kind === 3) {
      reader.skip(2);
    } else if (kind === 4) {
      reader.byte();
      reader.u32();
    } else {
      throw new Error(`WebAssembly import kind ${kind} is unsupported`);
    }
  }
  if (reader.at !== end) throw new Error('WebAssembly import section has trailing bytes');
  return functions;
}

function functionCount(source, start, end) {
  const reader = cursor(source);
  reader.at = start;
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) reader.u32();
  if (reader.at !== end) throw new Error('WebAssembly function section has trailing bytes');
  return count;
}

function functionExports(source, start, end) {
  const reader = cursor(source);
  reader.at = start;
  const count = reader.u32();
  const exports = new Map();
  for (let index = 0; index < count; index += 1) {
    const name = reader.name();
    const kind = reader.byte();
    const coordinate = reader.u32();
    if (kind === 0) exports.set(name, coordinate);
  }
  if (reader.at !== end) throw new Error('WebAssembly export section has trailing bytes');
  return exports;
}

function functionBodies(source, start, end) {
  const reader = cursor(source);
  reader.at = start;
  const count = reader.u32();
  const bodies = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.u32();
    const bodyStart = reader.at;
    reader.at = bodyStart + length;
    bodies.push({ start: bodyStart, end: reader.at });
  }
  if (reader.at !== end) throw new Error('WebAssembly code section has trailing bytes');
  return bodies;
}

export function openWasmFunction(raw, exportName) {
  const source = bytes(raw, 'WebAssembly module');
  if (source.length < 8
      || source[0] !== 0x00 || source[1] !== 0x61
      || source[2] !== 0x73 || source[3] !== 0x6d
      || source[4] !== 0x01 || source[5] !== 0x00
      || source[6] !== 0x00 || source[7] !== 0x00) {
    throw new Error('WebAssembly module header is invalid');
  }

  const sections = new Map();
  const reader = cursor(source);
  reader.at = 8;
  while (reader.at < source.length) {
    const id = reader.byte();
    const length = reader.u32();
    const start = reader.at;
    const end = start + length;
    if (end > source.length) throw new Error('WebAssembly section is truncated');
    if (id && sections.has(id)) {
      throw new Error(`WebAssembly section ${id} is duplicated`);
    }
    if (id) sections.set(id, { start, end });
    reader.at = end;
  }

  const imported = sections.has(2)
    ? importedFunctionCount(source, sections.get(2).start, sections.get(2).end)
    : 0;
  const defined = sections.has(3)
    ? functionCount(source, sections.get(3).start, sections.get(3).end)
    : 0;
  const exports = sections.has(7)
    ? functionExports(source, sections.get(7).start, sections.get(7).end)
    : new Map();
  const code = sections.get(10);
  const bodies = code ? functionBodies(source, code.start, code.end) : [];
  if (defined !== bodies.length) {
    throw new Error('WebAssembly function and code sections disagree');
  }
  const functionIndex = exports.get(exportName);
  if (functionIndex === undefined) {
    throw new Error(
      `the compiled module does not export ${exportName} `
      + `(exports: ${Array.from(exports.keys()).join(', ') || 'none'})`,
    );
  }
  const ordinal = functionIndex - imported;
  if (ordinal < 0 || ordinal >= bodies.length) {
    throw new Error(`WebAssembly export ${exportName} is imported or has no body`);
  }
  return {
    functionIndex,
    ...bodies[ordinal],
    source: {
      length: source.length,
      async read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
            || offset < 0 || length < 0 || offset + length > source.length) {
          throw new RangeError('WebAssembly byte range is invalid');
        }
        return source.slice(offset, offset + length);
      },
    },
  };
}

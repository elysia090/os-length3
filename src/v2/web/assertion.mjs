// Keep the success path free of diagnostic string materialization.
export function equal(actual,expected) {
  if(actual!==expected)throw new Error(`startup: ${String(actual)} != ${String(expected)}`);
}

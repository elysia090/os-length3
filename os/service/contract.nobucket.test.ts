// The Remote's contracts again, on a Remote with no bucket (bucket.ts): every
// test of contract.test.ts, so a route that does not move bytes can never
// come to need one unnoticed. Set before the file is read: its Remote is made
// as it loads.
process.env.REMOTE_TEST_BUCKET = 'none';
await import('./contract.test.ts');
export {};

// The Remote's contracts again, on a Remote with no bucket (bucket.ts): every
// test of contract.test.ts, so a route that does not move bytes can never
// come to need one unnoticed. Set before the file is read: its Remote is made
// as it loads. Read as a module of its own (the query makes it another), so it
// runs again here though contract.test.ts ran before it in this process
// (testing-together.ts).
process.env.REMOTE_TEST_BUCKET = 'none';
const again = './contract.test.ts?without-bucket';
await import(again);
export {};

// Synthetic subprocess behaviours for lifecycle tests. Never used by the app.
process.once('message', ({ bytes }) => {
  const action = bytes.toString();
  if (action === 'hang') { setInterval(() => {}, 1000); return; }
  if (action === 'crash') process.exit(7);
  if (action === 'invalid') { process.send({ text: 12 }); return; }
  const text = process.env.AIOS_TEST_SECRET || 'no inherited secret';
  process.send({ text, title: '', charCount: text.length, pageCount: 0, truncated: false, thin: true });
});

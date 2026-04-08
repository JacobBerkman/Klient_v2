const chunk = 'x'.repeat(32 * 1024)
for (let index = 0; index < 512; index += 1) {
  process.stdout.write(chunk)
}

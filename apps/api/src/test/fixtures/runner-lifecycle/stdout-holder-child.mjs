setInterval(() => {
  process.stdout.write('.')
}, 50)

setTimeout(() => {
  process.exit(0)
}, 500)

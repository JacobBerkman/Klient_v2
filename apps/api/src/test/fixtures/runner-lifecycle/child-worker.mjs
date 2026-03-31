const heartbeat = setInterval(() => {}, 25)

process.once('SIGTERM', () => {
  clearInterval(heartbeat)
  setTimeout(() => {
    process.exit(0)
  }, 40)
})

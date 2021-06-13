const WebSocket = require('ws')
const logkeeper = require('../scenarios/logkeeper')

init()

async function init () {
  const [json, logport] = process.argv.slice(2)
  const config = JSON.parse(json)
  const [host, PORT] = config.chat

  const name = `chatserver`
  const [log] = await logkeeper(name, logport)

  const wss = new WebSocket.Server({ port: PORT }, after)

  function after () {
    log({ type: 'chat', data: [`running on http://localhost:${wss.address().port}`] })
  }

  const connections = {}
  const history = []

  wss.on('connection', function connection (ws) {
    ws.on('message', function incoming (message) {
      message = JSON.parse(message)
      const { flow, type, data } = message
      const [name, id] = flow
      if (type === 'join') {
        if (!connections[name]) {
          connections[name] = { name, counter: id, ws }
          log({ type: 'chat', data: [`history: ${history}`] })
          history.forEach(data => {
            log({ type: 'chat', data: [`tell to [${name}] ${data}`] })
            ws.send(JSON.stringify(data))
          })
          return log({ type: 'chat', data: [`${type} ${flow}`] })
        } else {
          log({ type: 'error', data: [`${type} ${flow}`] })
          return ws.send(JSON.stringify({
            cite: [flow], type: 'error', data: 'name is already taken'
          }))
        }
      }
      log({ type: 'chat', data: [`[${name}] says: ${data}`] })
      history.push(data)
      Object.values(connections).map(({ ws, name }) => {
        ws.send(JSON.stringify(data))
      })
    })
  })
}

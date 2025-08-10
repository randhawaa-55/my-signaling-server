// signaling-server.js
// Pure WebSocket signaling for WebRTC screen-share + remote control (MVP)
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

/*
sessions: {
  "<sessionCode>": {
    id: "<uuid>",
    hostId: "<clientId>",
    clientId: "<clientId|null>",
    createdAt: "<iso>",
    controlEnabled: false
  }
}
clients: { "<clientId>": ws }
*/
const sessions = {};
const clients = {};

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore send errors
  }
}

function broadcastToSession(sessionId, obj) {
  // send to both host and client if present
  for (const cid in clients) {
    try {
      const ws = clients[cid];
      if (ws && ws._sessionId === sessionId) send(ws, obj);
    } catch (e) {}
  }
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients[clientId] = ws;
  ws._clientId = clientId;
  ws._sessionId = null; // will be set once client joins/creates
  console.log(`New connection: ${clientId}`);

  // tell client their id
  send(ws, { type: 'connected', clientId });

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) {
      send(ws, { type: 'error', message: 'invalid-json' });
      return;
    }

    const { type } = data;

    // ========== Host creates session ==========
    if (type === 'create-session') {
      const sessionCode = ('' + Math.floor(100000 + Math.random() * 900000)); // 6-digit
      const sessionId = uuidv4();
      sessions[sessionCode] = {
        id: sessionId,
        hostId: clientId,
        clientId: null,
        createdAt: new Date().toISOString(),
        controlEnabled: false
      };
      ws._sessionId = sessionId;
      send(ws, { type: 'session-created', sessionCode, sessionId });
      console.log(`Session ${sessionCode} created by host ${clientId}`);
      return;
    }

    // ========== Client joins session ==========
    if (type === 'join-session') {
      const { sessionCode } = data;
      if (!sessionCode || !sessions[sessionCode]) {
        send(ws, { type: 'error', message: 'invalid-session-code' });
        return;
      }
      const session = sessions[sessionCode];

      // check host availability
      const hostWs = clients[session.hostId];
      if (!hostWs) {
        delete sessions[sessionCode];
        send(ws, { type: 'error', message: 'host-not-available' });
        return;
      }

      // if already has client, reject or allow replacing disconnected
      if (session.clientId && clients[session.clientId]) {
        send(ws, { type: 'error', message: 'session-already-has-client' });
        return;
      }

      session.clientId = clientId;
      ws._sessionId = session.id;
      // notify both
      send(ws, { type: 'session-joined', sessionId: session.id, sessionCode });
      send(hostWs, { type: 'client-joined', clientId });
      console.log(`Client ${clientId} joined session ${sessionCode}`);
      return;
    }

    // ========== Signaling messages (offer/answer/ice) ==========
    if (type === 'offer' || type === 'answer' || type === 'ice-candidate') {
      const { sessionId, payload } = data;
      if (!sessionId) {
        send(ws, { type: 'error', message: 'missing-sessionId' });
        return;
      }
      // find session
      const sessionEntry = Object.values(sessions).find(s => s.id === sessionId);
      if (!sessionEntry) {
        send(ws, { type: 'error', message: 'unknown-session' });
        return;
      }

      // forward to the other peer
      const targetId = (sessionEntry.hostId === clientId) ? sessionEntry.clientId : sessionEntry.hostId;
      const targetWs = clients[targetId];
      if (targetWs) {
        send(targetWs, { type, from: clientId, payload });
      } else {
        send(ws, { type: 'error', message: 'peer-not-connected' });
      }
      return;
    }

    // ========== Control permission toggle ==========
    if (type === 'toggle-control') {
      const { sessionId, enabled } = data;
      const sessionEntry = Object.values(sessions).find(s => s.id === sessionId);
      if (!sessionEntry) { send(ws, { type: 'error', message: 'unknown-session' }); return; }
      // only host may toggle
      if (sessionEntry.hostId !== clientId) { send(ws, { type: 'error', message: 'not-host' }); return; }
      sessionEntry.controlEnabled = !!enabled;
      // notify session peers
      broadcastToSession(sessionEntry.id, { type: 'control-status', enabled: !!enabled });
      return;
    }

    // ========== Control event forwarding (optional, can also use data channel) ==========
    if (type === 'control-event') {
      const { sessionId, event } = data;
      const sessionEntry = Object.values(sessions).find(s => s.id === sessionId);
      if (!sessionEntry) { send(ws, { type: 'error', message: 'unknown-session' }); return; }
      // only forward if control enabled
      if (!sessionEntry.controlEnabled) { send(ws, { type: 'error', message: 'control-not-enabled' }); return; }
      // forward to host (if the sender is client) or to client (if host)
      const targetId = (sessionEntry.hostId === clientId) ? sessionEntry.clientId : sessionEntry.hostId;
      if (!targetId) { send(ws, { type: 'error', message: 'peer-not-connected' }); return; }
      const targetWs = clients[targetId];
      if (targetWs) {
        send(targetWs, { type: 'control-event', from: clientId, event });
      }
      return;
    }

    // unknown type
    send(ws, { type: 'error', message: 'unknown-type' });
  });

  ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${clientId} (${code})`);
    // cleanup client
    const sessionId = ws._sessionId;
    // remove from clients
    delete clients[clientId];

    if (sessionId) {
      // find session
      for (const code in sessions) {
        const s = sessions[code];
        if (s && s.id === sessionId) {
          // different handling for host disconnect vs client disconnect
          if (s.hostId === clientId) {
            // notify client and remove session
            if (s.clientId && clients[s.clientId]) {
              send(clients[s.clientId], { type: 'host-disconnected' });
            }
            delete sessions[code];
            console.log(`Session ${code} removed because host disconnected`);
          } else if (s.clientId === clientId) {
            // client disconnected: unset clientId and control
            s.clientId = null;
            s.controlEnabled = false;
            if (clients[s.hostId]) {
              send(clients[s.hostId], { type: 'client-disconnected' });
            }
            console.log(`Client removed from session ${code}`);
          }
          break;
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error for', clientId, err && err.message);
  });
});

console.log(`Signaling server running on ws://localhost:${PORT}`);

// signaling-server.js
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const sessions = {};
const clients = {};
const disconnectTimers = {};

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcastToSession(sessionId, obj) {
  for (const cid in clients) {
    const ws = clients[cid];
    if (ws && ws._sessionId === sessionId) send(ws, obj);
  }
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients[clientId] = ws;
  ws._clientId = clientId;
  ws._sessionId = null;
  console.log(`New connection: ${clientId}`);

  send(ws, { type: 'connected', clientId });

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { send(ws, { type: 'error', message: 'invalid-json' }); return; }
    const { type } = data;

    // === Restore old session if reconnect ===
    if (type === 'restore-session') {
      const { sessionCode, role } = data;
      const session = sessions[sessionCode];
      if (session) {
        clearTimeout(disconnectTimers[sessionCode]);
        if (role === 'host' && !clients[session.hostId]) {
          session.hostId = clientId;
          ws._sessionId = session.id;
          send(ws, { type: 'session-restored', sessionId: session.id, sessionCode });
          if (session.clientId && clients[session.clientId]) {
            send(clients[session.clientId], { type: 'host-reconnected' });
          }
          console.log(`Host reconnected to ${sessionCode}`);
          return;
        }
        if (role === 'client' && !clients[session.clientId]) {
          session.clientId = clientId;
          ws._sessionId = session.id;
          send(ws, { type: 'session-restored', sessionId: session.id, sessionCode });
          if (clients[session.hostId]) {
            send(clients[session.hostId], { type: 'client-reconnected' });
          }
          console.log(`Client reconnected to ${sessionCode}`);
          return;
        }
      }
      send(ws, { type: 'error', message: 'no-session-to-restore' });
      return;
    }

    // === Host creates session ===
    if (type === 'create-session') {
      const sessionCode = '' + Math.floor(100000 + Math.random() * 900000);
      const sessionId = uuidv4();
      sessions[sessionCode] = { id: sessionId, hostId: clientId, clientId: null, createdAt: new Date(), controlEnabled: false };
      ws._sessionId = sessionId;
      send(ws, { type: 'session-created', sessionCode, sessionId });
      console.log(`Session ${sessionCode} created by host ${clientId}`);
      return;
    }

    // === Client joins session ===
    if (type === 'join-session') {
      const { sessionCode } = data;
      const session = sessions[sessionCode];
      if (!session) { send(ws, { type: 'error', message: 'invalid-session-code' }); return; }

      const hostWs = clients[session.hostId];
      if (!hostWs) { delete sessions[sessionCode]; send(ws, { type: 'error', message: 'host-not-available' }); return; }

      if (session.clientId && clients[session.clientId]) {
        send(ws, { type: 'error', message: 'session-already-has-client' }); return;
      }

      session.clientId = clientId;
      ws._sessionId = session.id;
      send(ws, { type: 'session-joined', sessionId: session.id, sessionCode });
      send(hostWs, { type: 'client-joined', clientId });
      console.log(`Client ${clientId} joined session ${sessionCode}`);
      return;
    }

    // === Signaling ===
    if (['offer', 'answer', 'ice-candidate'].includes(type)) {
      const { sessionId, payload } = data;
      const sessionEntry = Object.values(sessions).find(s => s.id === sessionId);
      if (!sessionEntry) { send(ws, { type: 'error', message: 'unknown-session' }); return; }

      const targetId = (sessionEntry.hostId === clientId) ? sessionEntry.clientId : sessionEntry.hostId;
      const targetWs = clients[targetId];
      if (targetWs) send(targetWs, { type, from: clientId, payload });
      else send(ws, { type: 'error', message: 'peer-not-connected' });
      return;
    }

    // === Toggle control ===
    if (type === 'toggle-control') {
      const { sessionId, enabled } = data;
      const sessionEntry = Object.values(sessions).find(s => s.id === sessionId);
      if (!sessionEntry) { send(ws, { type: 'error', message: 'unknown-session' }); return; }
      if (sessionEntry.hostId !== clientId) { send(ws, { type: 'error', message: 'not-host' }); return; }
      sessionEntry.controlEnabled = !!enabled;
      broadcastToSession(sessionEntry.id, { type: 'control-status', enabled: !!enabled });
      return;
    }

    // === Forward control event ===
    if (type === 'control-event') {
      const { sessionId, event } = data;
      const sessionEntry = Object.values(sessions).find(s => s.id === sessionId);
      if (!sessionEntry || !sessionEntry.controlEnabled) { send(ws, { type: 'error', message: 'control-not-enabled' }); return; }
      const targetId = (sessionEntry.hostId === clientId) ? sessionEntry.clientId : sessionEntry.hostId;
      if (!targetId) return;
      const targetWs = clients[targetId];
      if (targetWs) send(targetWs, { type: 'control-event', from: clientId, event });
      return;
    }

    send(ws, { type: 'error', message: 'unknown-type' });
  });

  ws.on('close', () => {
    console.log(`Connection closed: ${clientId}`);
    const sessionId = ws._sessionId;
    delete clients[clientId];

    if (sessionId) {
      for (const code in sessions) {
        const s = sessions[code];
        if (s && s.id === sessionId) {
          if (s.hostId === clientId) {
            console.log(`Host disconnected from ${code}, waiting 2 minutes for reconnection...`);
            disconnectTimers[code] = setTimeout(() => {
              if (sessions[code] && sessions[code].hostId === clientId) {
                if (s.clientId && clients[s.clientId]) send(clients[s.clientId], { type: 'host-disconnected' });
                delete sessions[code];
                console.log(`Session ${code} removed after host grace period expired`);
              }
            }, 120000);
          } else if (s.clientId === clientId) {
            console.log(`Client disconnected from ${code}, waiting 2 minutes for reconnection...`);
            disconnectTimers[code] = setTimeout(() => {
              if (sessions[code] && sessions[code].clientId === clientId) {
                s.clientId = null;
                s.controlEnabled = false;
                if (clients[s.hostId]) send(clients[s.hostId], { type: 'client-disconnected' });
                console.log(`Client removed from session ${code} after grace period expired`);
              }
            }, 120000);
          }
          break;
        }
      }
    }
  });

  ws.on('error', (err) => console.error('WebSocket error for', clientId, err?.message));
});

console.log(`Signaling server running on ws://localhost:${PORT}`);

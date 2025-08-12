const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const sessions = {}; // sessionCode -> session data
const clients = {};  // clientId -> ws

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {}
}

function broadcastToSession(sessionId, obj) {
  for (const cid in clients) {
    const ws = clients[cid];
    if (ws && ws._sessionId === sessionId) send(ws, obj);
  }
}

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const clientId = uuidv4();
  clients[clientId] = ws;
  ws._clientId = clientId;
  ws._sessionId = null;
  ws._role = null; // 'host' or 'client'

  console.log(`New connection: ${clientId}`);
  send(ws, { type: 'connected', clientId });

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) {
      send(ws, { type: 'error', message: 'invalid-json' });
      return;
    }

    const { type } = data;

    // Reconnect request
    if (type === 'reconnect-session') {
      const { sessionCode, role } = data;
      if (sessionCode && sessions[sessionCode]) {
        const session = sessions[sessionCode];
        ws._sessionId = session.id;
        ws._role = role;
        if (role === 'host') {
          session.hostId = ws._clientId;
          session.hostOffline = false;
          if (session.clientId && clients[session.clientId]) {
            send(clients[session.clientId], { type: 'host-reconnected' });
          }
        } else {
          session.clientId = ws._clientId;
          session.clientOffline = false;
          if (clients[session.hostId]) {
            send(clients[session.hostId], { type: 'client-reconnected' });
          }
        }
        send(ws, { type: 'session-rejoined', sessionId: session.id });
        console.log(`${role} rejoined session ${sessionCode}`);
      }
      return;
    }

    // Host creates session
    if (type === 'create-session') {
      const sessionCode = String(Math.floor(100000 + Math.random() * 900000));
      const sessionId = uuidv4();
      sessions[sessionCode] = {
        id: sessionId,
        hostId: clientId,
        clientId: null,
        createdAt: new Date().toISOString(),
        controlEnabled: false,
        hostOffline: false,
        clientOffline: false
      };
      ws._sessionId = sessionId;
      ws._role = 'host';
      send(ws, { type: 'session-created', sessionCode, sessionId });
      console.log(`Session ${sessionCode} created by host ${clientId}`);
      return;
    }

    // Client joins session
    if (type === 'join-session') {
      const { sessionCode } = data;
      if (!sessionCode || !sessions[sessionCode]) {
        send(ws, { type: 'error', message: 'invalid-session-code' });
        return;
      }
      const session = sessions[sessionCode];
      if (!clients[session.hostId]) {
        send(ws, { type: 'error', message: 'host-not-available' });
        return;
      }
      if (session.clientId && clients[session.clientId]) {
        send(ws, { type: 'error', message: 'session-already-has-client' });
        return;
      }
      session.clientId = clientId;
      ws._sessionId = session.id;
      ws._role = 'client';
      send(ws, { type: 'session-joined', sessionId: session.id, sessionCode });
      send(clients[session.hostId], { type: 'client-joined', clientId });
      console.log(`Client ${clientId} joined session ${sessionCode}`);
      return;
    }

    // Reconnect to existing session
    if (type === 'reconnect-session') {
      const { sessionCode, role } = data;
      if (!sessionCode || !sessions[sessionCode]) {
        send(ws, { type: 'reconnect-session-failed', message: 'Session no longer exists' });
        return;
      }
      const session = sessions[sessionCode];
      
      if (role === 'host') {
        // Reconnect as host
        if (session.hostId && clients[session.hostId]) {
          send(ws, { type: 'reconnect-session-failed', message: 'Host already connected' });
          return;
        }
        session.hostId = clientId;
        session.hostOffline = false;
        ws._sessionId = session.id;
        ws._role = 'host';
        send(ws, { type: 'reconnect-session-success', sessionId: session.id, sessionCode });
        console.log(`Host ${clientId} reconnected to session ${sessionCode}`);
      } else if (role === 'client') {
        // Reconnect as client
        if (session.clientId && clients[session.clientId]) {
          send(ws, { type: 'reconnect-session-failed', message: 'Client already connected' });
          return;
        }
        if (!clients[session.hostId]) {
          send(ws, { type: 'reconnect-session-failed', message: 'Host not available' });
          return;
        }
        session.clientId = clientId;
        session.clientOffline = false;
        ws._sessionId = session.id;
        ws._role = 'client';
        send(ws, { type: 'reconnect-session-success', sessionId: session.id, sessionCode });
        send(clients[session.hostId], { type: 'client-joined', clientId });
        console.log(`Client ${clientId} reconnected to session ${sessionCode}`);
      } else {
        send(ws, { type: 'reconnect-session-failed', message: 'Invalid role' });
      }
      return;
    }

    // Signaling
    if (['offer', 'answer', 'ice-candidate'].includes(type)) {
      const { sessionId, payload } = data;
      const session = Object.values(sessions).find(s => s.id === sessionId);
      if (!session) {
        send(ws, { type: 'error', message: 'unknown-session' });
        return;
      }
      const targetId = (session.hostId === clientId) ? session.clientId : session.hostId;
      const targetWs = clients[targetId];
      if (targetWs) send(targetWs, { type, from: clientId, payload });
      return;
    }

    // Toggle control
    if (type === 'toggle-control') {
      const { sessionId, enabled } = data;
      const session = Object.values(sessions).find(s => s.id === sessionId);
      if (session && session.hostId === clientId) {
        session.controlEnabled = !!enabled;
        broadcastToSession(session.id, { type: 'control-status', enabled: !!enabled });
      }
      return;
    }
  });

  ws.on('close', () => {
    const sessionId = ws._sessionId;
    delete clients[clientId];
    if (sessionId) {
      for (const code in sessions) {
        const s = sessions[code];
        if (s && s.id === sessionId) {
          if (s.hostId === clientId) {
            s.hostOffline = true;
            if (s.clientId && clients[s.clientId]) {
              send(clients[s.clientId], { type: 'host-offline' });
            }
          } else if (s.clientId === clientId) {
            s.clientOffline = true;
            s.controlEnabled = false;
            if (clients[s.hostId]) {
              send(clients[s.hostId], { type: 'client-offline' });
            }
          }
          break;
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${clientId}:`, err.message);
  });
});

// Ping loop
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

console.log(`Signaling server running on ws://localhost:${PORT}`);

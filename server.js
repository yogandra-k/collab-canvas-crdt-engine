const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const crdtEngine = require('./src/crdtEngine');
const pubsubCluster = require('./src/pubsubCluster');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multi-server pub/sub channel for room synchronization
pubsubCluster.subscribe('CANVAS_ROOM_BROADCAST', (msg) => {
    // Broadcast to matching local WS clients
    wss.clients.forEach((client) => {
        if (client.readyState === 1 && client.roomId === msg.roomId) {
            client.send(JSON.stringify(msg.data));
        }
    });
});

wss.on('connection', (ws, req) => {
    const peerId = `peer_${Math.random().toString(36).substr(2, 6)}`;
    const colors = ['#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316'];
    const peerColor = colors[Math.floor(Math.random() * colors.length)];
    const roomId = 'board_alpha_main';

    ws.peerId = peerId;
    ws.roomId = roomId;
    ws.peerColor = peerColor;

    // Send initial handshake state snapshot
    const initialSnapshot = crdtEngine.getRoomSnapshot(roomId);
    ws.send(JSON.stringify({
        type: 'INIT_SNAPSHOT',
        peerId,
        peerColor,
        roomId,
        snapshot: initialSnapshot
    }));

    // Handle incoming client packets (Mutations, Cursor Movements, Virtual Users)
    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data.toString());

            if (payload.type === 'CANVAS_OP') {
                const result = crdtEngine.applyOperation(roomId, {
                    ...payload.operation,
                    peerId
                });

                // Publish update over Redis Pub/Sub cluster
                pubsubCluster.publish('CANVAS_ROOM_BROADCAST', {
                    roomId,
                    data: {
                        type: 'REMOTE_OP_APPLIED',
                        operation: payload.operation,
                        peerId,
                        serverClock: result.serverClock,
                        totalElements: result.activeCount
                    }
                });
            } else if (payload.type === 'CURSOR_MOVE') {
                crdtEngine.updatePeerCursor(roomId, peerId, {
                    x: payload.x,
                    y: payload.y,
                    color: peerColor,
                    name: payload.name || `User (${peerId.substr(5)})`
                });

                pubsubCluster.publish('CANVAS_ROOM_BROADCAST', {
                    roomId,
                    data: {
                        type: 'PEER_CURSOR_UPDATE',
                        peerId,
                        x: payload.x,
                        y: payload.y,
                        color: peerColor,
                        name: payload.name || `User (${peerId.substr(5)})`
                    }
                });
            }
        } catch (err) {
            console.error('WS Message parsing error:', err);
        }
    });

    ws.on('close', () => {
        crdtEngine.removePeer(roomId, peerId);
        pubsubCluster.publish('CANVAS_ROOM_BROADCAST', {
            roomId,
            data: {
                type: 'PEER_DISCONNECTED',
                peerId
            }
        });
    });
});

// REST API Endpoints
app.get('/api/board/snapshot', (req, res) => {
    res.json(crdtEngine.getRoomSnapshot('board_alpha_main'));
});

app.post('/api/board/clear', (req, res) => {
    crdtEngine.applyOperation('board_alpha_main', {
        type: 'ELEMENT_BATCH_CLEAR',
        peerId: 'admin_console'
    });
    pubsubCluster.publish('CANVAS_ROOM_BROADCAST', {
        roomId: 'board_alpha_main',
        data: { type: 'CANVAS_CLEARED' }
    });
    res.json({ status: 'success', message: 'Board canvas cleared.' });
});

app.post('/api/board/spawn-bots', (req, res) => {
    const { count = 10 } = req.body;
    const botColors = ['#e11d48', '#d97706', '#059669', '#7c3aed', '#0284c7'];
    
    // Simulate real-time bot drawing activity over CRDT engine
    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const botId = `bot_${Math.floor(Math.random() * 900 + 100)}`;
            const shapes = ['rect', 'sticky', 'circle'];
            const shapeType = shapes[Math.floor(Math.random() * shapes.length)];
            const color = botColors[Math.floor(Math.random() * botColors.length)];

            const elem = {
                id: `elem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                type: shapeType,
                x: Math.floor(Math.random() * 600) + 100,
                y: Math.floor(Math.random() * 350) + 80,
                w: shapeType === 'sticky' ? 140 : 120,
                h: shapeType === 'sticky' ? 110 : 80,
                color,
                text: shapeType === 'sticky' ? `CRDT Synced by ${botId}` : '',
                lamportClock: Date.now()
            };

            crdtEngine.applyOperation('board_alpha_main', {
                type: 'ELEMENT_UPSERT',
                element: elem,
                peerId: botId
            });

            pubsubCluster.publish('CANVAS_ROOM_BROADCAST', {
                roomId: 'board_alpha_main',
                data: {
                    type: 'REMOTE_OP_APPLIED',
                    operation: { type: 'ELEMENT_UPSERT', element: elem },
                    peerId: botId
                }
            });
        }, i * 150);
    }

    res.json({ status: 'success', spawned: count });
});

app.get('/api/stats', (req, res) => {
    res.json({
        crdt: crdtEngine.getStats(),
        pubsub: pubsubCluster.getStats()
    });
});

server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🎨 Real-Time Collaborative CRDT Whiteboard Engine Started!`);
    console.log(`📍 Web Canvas Studio: http://localhost:${PORT}`);
    console.log(`⚡ WebSocket Synced on port ${PORT}`);
    console.log(`=======================================================`);
});

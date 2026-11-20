let canvas, ctx;
let socket;
let currentTool = 'draw'; // 'select', 'draw', 'rect', 'circle', 'sticky'
let currentColor = '#f59e0b';
let myPeerId = null;
let myColor = '#f59e0b';

// Local CRDT State
const elementsMap = new Map();
const remoteCursors = new Map();
let isDrawing = false;
let currentPath = [];
let shapeStart = null;
let pendingStickyPos = null;

function initCanvas() {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Mouse & Touch events
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
}

function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    renderBoard();
}

// WebSocket Full-Duplex Connection
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onopen = () => {
        document.getElementById('ws-state-badge').innerText = 'SYNCED';
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'INIT_SNAPSHOT') {
                myPeerId = data.peerId;
                myColor = data.peerColor;
                document.getElementById('hud-clock').innerText = data.snapshot.lamportClock;

                // Load initial elements
                data.snapshot.elements.forEach(elem => elementsMap.set(elem.id, elem));
                renderBoard();
                updateAvatars();
            } else if (data.type === 'REMOTE_OP_APPLIED') {
                const { operation, serverClock } = data;
                if (operation.type === 'ELEMENT_UPSERT') {
                    elementsMap.set(operation.element.id, operation.element);
                } else if (operation.type === 'ELEMENT_DELETE') {
                    elementsMap.delete(operation.elementId);
                }
                document.getElementById('hud-clock').innerText = serverClock || 0;
                renderBoard();
            } else if (data.type === 'PEER_CURSOR_UPDATE') {
                if (data.peerId !== myPeerId) {
                    remoteCursors.set(data.peerId, data);
                    renderCursors();
                    updateAvatars();
                }
            } else if (data.type === 'PEER_DISCONNECTED') {
                remoteCursors.delete(data.peerId);
                renderCursors();
                updateAvatars();
            } else if (data.type === 'CANVAS_CLEARED') {
                elementsMap.clear();
                renderBoard();
            }
        } catch (err) {
            console.error('WS Parse Error:', err);
        }
    };
}

// Drawing & Mutation Handlers
function handleMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (currentTool === 'draw') {
        isDrawing = true;
        currentPath = [{ x, y }];
    } else if (currentTool === 'rect' || currentTool === 'circle') {
        isDrawing = true;
        shapeStart = { x, y };
    } else if (currentTool === 'sticky') {
        pendingStickyPos = { x, y };
        const pop = document.getElementById('sticky-pop');
        pop.style.left = `${e.clientX + 10}px`;
        pop.style.top = `${e.clientY + 10}px`;
        pop.style.display = 'flex';
        document.getElementById('sticky-input').focus();
    }
}

function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Send cursor position over WebSocket
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'CURSOR_MOVE',
            x, y
        }));
    }

    if (!isDrawing) return;

    if (currentTool === 'draw') {
        currentPath.push({ x, y });
        renderBoard();
        // Render live local stroke
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < currentPath.length; i++) {
            if (i === 0) ctx.moveTo(currentPath[i].x, currentPath[i].y);
            else ctx.lineTo(currentPath[i].x, currentPath[i].y);
        }
        ctx.stroke();
    } else if (currentTool === 'rect' && shapeStart) {
        renderBoard();
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(shapeStart.x, shapeStart.y, x - shapeStart.x, y - shapeStart.y);
    } else if (currentTool === 'circle' && shapeStart) {
        renderBoard();
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 2;
        const radius = Math.sqrt(Math.pow(x - shapeStart.x, 2) + Math.pow(y - shapeStart.y, 2));
        ctx.beginPath();
        ctx.arc(shapeStart.x, shapeStart.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
    }
}

function handleMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (currentTool === 'draw' && currentPath.length > 1) {
        const elem = {
            id: `path_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'path',
            points: currentPath,
            color: currentColor,
            width: 3,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    } else if (currentTool === 'rect' && shapeStart) {
        const elem = {
            id: `rect_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'rect',
            x: Math.min(shapeStart.x, x),
            y: Math.min(shapeStart.y, y),
            w: Math.abs(x - shapeStart.x),
            h: Math.abs(y - shapeStart.y),
            color: currentColor,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    } else if (currentTool === 'circle' && shapeStart) {
        const radius = Math.sqrt(Math.pow(x - shapeStart.x, 2) + Math.pow(y - shapeStart.y, 2));
        const elem = {
            id: `circle_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'circle',
            x: shapeStart.x,
            y: shapeStart.y,
            radius,
            color: currentColor,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    }

    currentPath = [];
    shapeStart = null;
}

function commitStickyNote() {
    const input = document.getElementById('sticky-input');
    const text = input.value.trim() || 'Quick Memo';
    if (pendingStickyPos) {
        const elem = {
            id: `sticky_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'sticky',
            x: pendingStickyPos.x,
            y: pendingStickyPos.y,
            w: 160,
            h: 120,
            text,
            color: currentColor,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    }
    input.value = '';
    document.getElementById('sticky-pop').style.display = 'none';
    pendingStickyPos = null;
}

function dispatchCanvasOp(element) {
    elementsMap.set(element.id, element);
    renderBoard();

    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'CANVAS_OP',
            operation: {
                type: 'ELEMENT_UPSERT',
                element
            }
        }));
    }
}

// Canvas Rendering Loop
function renderBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    document.getElementById('hud-elements').innerText = elementsMap.size;

    elementsMap.forEach((elem) => {
        if (elem.type === 'path' && elem.points) {
            ctx.strokeStyle = elem.color || '#f59e0b';
            ctx.lineWidth = elem.width || 3;
            ctx.lineCap = 'round';
            ctx.beginPath();
            elem.points.forEach((p, idx) => {
                if (idx === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
        } else if (elem.type === 'rect') {
            ctx.strokeStyle = elem.color || '#f59e0b';
            ctx.lineWidth = 2;
            ctx.strokeRect(elem.x, elem.y, elem.w, elem.h);
        } else if (elem.type === 'circle') {
            ctx.strokeStyle = elem.color || '#f59e0b';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(elem.x, elem.y, elem.radius || 30, 0, 2 * Math.PI);
            ctx.stroke();
        } else if (elem.type === 'sticky') {
            // Draw Sticky Card
            ctx.fillStyle = elem.color || '#f59e0b';
            ctx.beginPath();
            ctx.roundRect(elem.x, elem.y, elem.w, elem.h, 8);
            ctx.fill();

            // Text
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 12px "Space Grotesk", sans-serif';
            ctx.fillText(elem.text || '', elem.x + 12, elem.y + 28, elem.w - 24);
        }
    });
}

// Render Remote Cursors
function renderCursors() {
    const layer = document.getElementById('cursors-layer');
    layer.innerHTML = '';

    remoteCursors.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'remote-cursor';
        el.style.left = `${c.x}px`;
        el.style.top = `${c.y}px`;

        el.innerHTML = `
            <svg class="cursor-pointer-svg" viewBox="0 0 24 24" fill="${c.color || '#10b981'}">
                <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.85a.5.5 0 0 0-.85.36z"/>
            </svg>
            <span class="cursor-tag" style="background: ${c.color || '#10b981'};">${c.name || 'Peer'}</span>
        `;
        layer.appendChild(el);
    });

    document.getElementById('hud-peers').innerText = remoteCursors.size + 1;
}

function updateAvatars() {
    const cont = document.getElementById('peer-avatars');
    cont.innerHTML = `<div class="peer-avatar-circle" style="background: ${myColor};">YOU</div>`;
    remoteCursors.forEach((c) => {
        const av = document.createElement('div');
        av.className = 'peer-avatar-circle';
        av.style.background = c.color;
        av.innerText = (c.name || 'P').charAt(0).toUpperCase();
        cont.appendChild(av);
    });
}

// Tools & Helpers
function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tool-${tool}`).classList.add('active');
}

function setColor(color) {
    currentColor = color;
    document.querySelectorAll('.color-dot').forEach(dot => {
        dot.classList.toggle('active', dot.style.background === color || dot.style.backgroundColor === color);
    });
}

async function spawnBotSwarm() {
    await fetch('/api/board/spawn-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 8 })
    });
}

async function clearBoardCanvas() {
    await fetch('/api/board/clear', { method: 'POST' });
}

window.addEventListener('DOMContentLoaded', () => {
    initCanvas();
    initWebSocket();
});

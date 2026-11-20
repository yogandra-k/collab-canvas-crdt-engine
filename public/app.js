let canvas, ctx;
let socket;
let currentTool = 'draw'; // 'select', 'draw', 'rect', 'circle', 'sticky', 'arrow', 'eraser', 'laser'
let currentColor = '#f59e0b';
let currentStrokeWidth = 3;
let myPeerId = null;
let myColor = '#f59e0b';

// Local CRDT State
const elementsMap = new Map();
const remoteCursors = new Map();
let isDrawing = false;
let currentPath = [];
let shapeStart = null;
let pendingStickyPos = null;

// Zoom & Pan viewport state
let zoom = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;

// Minimap
let minimapVisible = true;

function initCanvas() {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Mouse & Touch events
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleZoomWheel);

    // Keyboard Shortcuts
    window.addEventListener('keydown', handleKeyboardShortcuts);
}

function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    renderBoard();
}

function handleKeyboardShortcuts(e) {
    const key = e.key.toLowerCase();
    if (document.activeElement.tagName === 'INPUT') return; // ignore typing
    if (key === 'v') setTool('select');
    if (key === 'p') setTool('draw');
    if (key === 'r') setTool('rect');
    if (key === 'o') setTool('circle');
    if (key === 's') setTool('sticky');
    if (key === 'e') setTool('eraser');
    if (key === 'a') setTool('arrow');
    if (key === 'l') setTool('laser');
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
            } else if (data.type === 'PEER_REACTION') {
                spawnFloatingReaction(data.emoji, data.x, data.y);
            }
        } catch (err) {
            console.error('WS Parse Error:', err);
        }
    };
}

// Zoom Wheel Handler
function handleZoomWheel(e) {
    e.preventDefault();
    const zoomFactor = 0.05;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Convert mouse screen pos to world pos before zooming
    const worldX = (mouseX - panX) / zoom;
    const worldY = (mouseY - panY) / zoom;

    if (e.deltaY < 0) {
        zoom = Math.min(3.0, zoom + zoomFactor);
    } else {
        zoom = Math.max(0.4, zoom - zoomFactor);
    }

    // Adjust pan to zoom into mouse focal point
    panX = mouseX - worldX * zoom;
    panY = mouseY - worldY * zoom;

    updateZoomUI();
    renderBoard();
}

function adjustZoom(factor) {
    zoom = Math.max(0.4, Math.min(3.0, zoom + factor));
    updateZoomUI();
    renderBoard();
}

function resetZoomAndPan() {
    zoom = 1.0;
    panX = 0;
    panY = 0;
    updateZoomUI();
    renderBoard();
}

function updateZoomUI() {
    document.getElementById('zoom-text').innerText = `${Math.round(zoom * 100)}%`;
    document.getElementById('hud-viewport').innerText = `${zoom.toFixed(1)}x (${Math.round(panX)}, ${Math.round(panY)})`;
}

// Coordinate conversions
function screenToWorld(sX, sY) {
    return {
        x: (sX - panX) / zoom,
        y: (sY - panY) / zoom
    };
}

function worldToScreen(wX, wY) {
    return {
        x: wX * zoom + panX,
        y: wY * zoom + panY
    };
}

// Drawing & Mutation Handlers
function handleMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const sX = e.clientX - rect.left;
    const sY = e.clientY - rect.top;
    
    // Middle click or Space/Select tools triggers PANning
    if (e.button === 1 || currentTool === 'select') {
        isPanning = true;
        startPanX = sX - panX;
        startPanY = sY - panY;
        canvas.style.cursor = 'grabbing';
        return;
    }

    const world = screenToWorld(sX, sY);

    if (currentTool === 'draw') {
        isDrawing = true;
        currentPath = [world];
    } else if (currentTool === 'rect' || currentTool === 'circle' || currentTool === 'arrow') {
        isDrawing = true;
        shapeStart = world;
    } else if (currentTool === 'sticky') {
        pendingStickyPos = world;
        const pop = document.getElementById('sticky-pop');
        pop.style.left = `${e.clientX + 10}px`;
        pop.style.top = `${e.clientY + 10}px`;
        pop.style.display = 'flex';
        document.getElementById('sticky-input').focus();
    } else if (currentTool === 'eraser') {
        isDrawing = true;
        eraseAtWorldCoords(world);
    }
}

function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const sX = e.clientX - rect.left;
    const sY = e.clientY - rect.top;

    if (isPanning) {
        panX = sX - startPanX;
        panY = sY - startPanY;
        updateZoomUI();
        renderBoard();
        return;
    }

    const world = screenToWorld(sX, sY);

    // Send cursor position over WebSocket (World Coords)
    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'CURSOR_MOVE',
            x: world.x,
            y: world.y,
            name: `User (${myPeerId?.substr(5) || 'Guest'})`
        }));
    }

    if (!isDrawing) return;

    if (currentTool === 'draw') {
        currentPath.push(world);
        renderBoard();
        
        // Dynamic live trace
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = currentStrokeWidth / zoom;
        ctx.lineCap = 'round';
        ctx.beginPath();
        currentPath.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.restore();
    } else if (currentTool === 'rect' && shapeStart) {
        renderBoard();
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 2 / zoom;
        ctx.strokeRect(shapeStart.x, shapeStart.y, world.x - shapeStart.x, world.y - shapeStart.y);
        ctx.restore();
    } else if (currentTool === 'circle' && shapeStart) {
        renderBoard();
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 2 / zoom;
        const radius = Math.sqrt(Math.pow(world.x - shapeStart.x, 2) + Math.pow(world.y - shapeStart.y, 2));
        ctx.beginPath();
        ctx.arc(shapeStart.x, shapeStart.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.restore();
    } else if (currentTool === 'arrow' && shapeStart) {
        renderBoard();
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 3 / zoom;
        ctx.fillStyle = currentColor;
        drawArrowHead(shapeStart.x, shapeStart.y, world.x, world.y);
        ctx.restore();
    } else if (currentTool === 'eraser') {
        eraseAtWorldCoords(world);
    }
}

function handleMouseUp(e) {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = currentTool === 'select' ? 'grabbing' : 'crosshair';
        return;
    }
    if (!isDrawing) return;
    isDrawing = false;
    
    const rect = canvas.getBoundingClientRect();
    const sX = e.clientX - rect.left;
    const sY = e.clientY - rect.top;
    const world = screenToWorld(sX, sY);

    if (currentTool === 'draw' && currentPath.length > 1) {
        const elem = {
            id: `path_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'path',
            points: currentPath,
            color: currentColor,
            width: currentStrokeWidth,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    } else if (currentTool === 'rect' && shapeStart) {
        const elem = {
            id: `rect_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'rect',
            x: Math.min(shapeStart.x, world.x),
            y: Math.min(shapeStart.y, world.y),
            w: Math.abs(world.x - shapeStart.x),
            h: Math.abs(world.y - shapeStart.y),
            color: currentColor,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    } else if (currentTool === 'circle' && shapeStart) {
        const radius = Math.sqrt(Math.pow(world.x - shapeStart.x, 2) + Math.pow(world.y - shapeStart.y, 2));
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
    } else if (currentTool === 'arrow' && shapeStart) {
        const elem = {
            id: `arrow_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'arrow',
            x1: shapeStart.x,
            y1: shapeStart.y,
            x2: world.x,
            y2: world.y,
            color: currentColor,
            lamportClock: Date.now()
        };
        dispatchCanvasOp(elem);
    }

    currentPath = [];
    shapeStart = null;
}

function eraseAtWorldCoords(wCoords) {
    // Check if any element center lies close to erasure point (approx 20px radius)
    const eraseRadius = 24;
    elementsMap.forEach((elem) => {
        let isHit = false;
        if (elem.type === 'rect' || elem.type === 'sticky') {
            isHit = (wCoords.x >= elem.x && wCoords.x <= elem.x + elem.w && wCoords.y >= elem.y && wCoords.y <= elem.y + elem.h);
        } else if (elem.type === 'circle') {
            const d = Math.sqrt(Math.pow(wCoords.x - elem.x, 2) + Math.pow(wCoords.y - elem.y, 2));
            isHit = (d <= (elem.radius || 30));
        } else if (elem.type === 'path' && elem.points) {
            isHit = elem.points.some(p => Math.sqrt(Math.pow(wCoords.x - p.x, 2) + Math.pow(wCoords.y - p.y, 2)) < eraseRadius);
        }

        if (isHit) {
            elementsMap.delete(elem.id);
            if (socket && socket.readyState === 1) {
                socket.send(JSON.stringify({
                    type: 'CANVAS_OP',
                    operation: {
                        type: 'ELEMENT_DELETE',
                        elementId: elem.id
                    }
                }));
            }
            renderBoard();
        }
    });
}

// Arrow head math
function drawArrowHead(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 12 * Math.cos(angle - Math.PI / 6), y2 - 12 * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - 12 * Math.cos(angle + Math.PI / 6), y2 - 12 * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
}

function commitStickyNote() {
    const input = document.getElementById('sticky-input');
    const text = input.value.trim() || 'Interactive Node';
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
    // Confetti celebration if a sticky memo card is successfully posted
    if (element.type === 'sticky') {
        confetti({ particleCount: 60, spread: 40, origin: { y: 0.8 } });
    }
}

// Canvas Rendering Loop
function renderBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById('hud-elements').innerText = elementsMap.size;

    // Apply Zoom & Pan Matrix
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

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
        } else if (elem.type === 'arrow') {
            ctx.strokeStyle = elem.color || '#f59e0b';
            ctx.fillStyle = elem.color || '#f59e0b';
            ctx.lineWidth = 3;
            drawArrowHead(elem.x1, elem.y1, elem.x2, elem.y2);
        } else if (elem.type === 'sticky') {
            // Rounded glassmorphism-styled Sticky card
            ctx.fillStyle = elem.color || '#f59e0b';
            ctx.beginPath();
            ctx.roundRect(elem.x, elem.y, elem.w, elem.h, 8);
            ctx.fill();

            // Sticky inner text
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 12px "Space Grotesk", sans-serif';
            ctx.fillText(elem.text || '', elem.x + 12, elem.y + 28, elem.w - 24);
        }
    });

    ctx.restore();
    renderMinimap();
}

// Multi-User Live Cursor Render Overlay (Adjusted for zoom & pan world space)
function renderCursors() {
    const layer = document.getElementById('cursors-layer');
    layer.innerHTML = '';

    remoteCursors.forEach((c) => {
        // Convert world coords to screen space pos for visual accuracy
        const sPos = worldToScreen(c.x, c.y);

        const el = document.createElement('div');
        el.className = 'remote-cursor';
        el.style.left = `${sPos.x}px`;
        el.style.top = `${sPos.y}px`;

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

// RADAR VIEWPORT (Minimap Drawer)
function renderMinimap() {
    if (!minimapVisible) return;
    const mCanvas = document.getElementById('minimap-canvas');
    const mCtx = mCanvas.getContext('2d');
    mCtx.clearRect(0, 0, mCanvas.width, mCanvas.height);

    // Scaling factor (Canvas screen is scaled down by 10x inside minimap container)
    const scale = 0.12;
    mCtx.save();
    mCtx.scale(scale, scale);

    // Draw active vector elements inside Radar view
    elementsMap.forEach((elem) => {
        mCtx.fillStyle = elem.color || '#f59e0b';
        mCtx.strokeStyle = elem.color || '#f59e0b';
        if (elem.type === 'rect' || elem.type === 'sticky') {
            mCtx.fillRect(elem.x, elem.y, elem.w, elem.h);
        } else if (elem.type === 'circle') {
            mCtx.beginPath();
            mCtx.arc(elem.x, elem.y, elem.radius || 20, 0, 2 * Math.PI);
            mCtx.fill();
        } else if (elem.type === 'path' && elem.points) {
            mCtx.lineWidth = 6;
            mCtx.beginPath();
            elem.points.forEach((p, idx) => {
                if (idx === 0) mCtx.moveTo(p.x, p.y);
                else mCtx.lineTo(p.x, p.y);
            });
            mCtx.stroke();
        }
    });

    // Draw active client viewport boundary box in Radar view
    mCtx.strokeStyle = 'var(--accent-amber)';
    mCtx.lineWidth = 4;
    // Map screen coordinates back to Radar world space boundaries
    const boundTL = screenToWorld(0, 0);
    const boundBR = screenToWorld(canvas.width, canvas.height);
    mCtx.strokeRect(boundTL.x, boundTL.y, boundBR.x - boundTL.x, boundBR.y - boundTL.y);

    mCtx.restore();
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

// Tools, Reactions, and HUD Toggles
function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tool-${tool}`).classList.add('active');
    canvas.style.cursor = tool === 'select' ? 'grabbing' : 'crosshair';
}

function setColor(color) {
    currentColor = color;
    document.querySelectorAll('.color-dot').forEach(dot => {
        dot.classList.toggle('active', dot.style.background === color || dot.style.backgroundColor === color);
    });
}

function setStrokeWidth(width) {
    currentStrokeWidth = width;
    document.querySelectorAll('.width-btn').forEach(btn => {
        const titleText = btn.getAttribute('title').toLowerCase();
        const activeLabel = width === 3 ? 'fine' : width === 6 ? 'medium' : 'thick';
        btn.classList.toggle('active', titleText.includes(activeLabel));
    });
}

function toggleMiniMap() {
    minimapVisible = !minimapVisible;
    document.getElementById('minimap-container').style.display = minimapVisible ? 'flex' : 'none';
    renderBoard();
}

// Real-Time Emoji Reaction Floating Animation
function fireReaction(emoji) {
    // Generate reaction location close to middle client screen pos
    const x = canvas.width / 2 + (Math.random() - 0.5) * 200;
    const y = canvas.height * 0.7;

    spawnFloatingReaction(emoji, x, y);

    if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify({
            type: 'PEER_REACTION',
            emoji, x, y
        }));
    }
}

function spawnFloatingReaction(emoji, x, y) {
    const container = document.getElementById('canvas-container');
    const el = document.createElement('div');
    el.className = 'floating-emoji-item';
    el.innerText = emoji;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    container.appendChild(el);
    setTimeout(() => el.remove(), 1800);
}

// Spatial Audio Channel Toggle Simulation
let voiceActive = false;
function toggleAudioChat() {
    voiceActive = !voiceActive;
    const pill = document.getElementById('audio-pill');
    pill.style.display = voiceActive ? 'flex' : 'none';
}

// High-fidelity local PNG export capability
function exportCanvasPNG() {
    // Generate offline image representation
    const link = document.createElement('a');
    link.download = `CollabFlow_Workspace_${Date.now()}.png`;
    link.href = canvas.toDataURL();
    link.click();
}

async function spawnBotSwarm() {
    await fetch('/api/board/spawn-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 10 })
    });
}

async function clearBoardCanvas() {
    await fetch('/api/board/clear', { method: 'POST' });
}

window.addEventListener('DOMContentLoaded', () => {
    initCanvas();
    initWebSocket();
});

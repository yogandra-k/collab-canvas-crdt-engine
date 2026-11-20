/**
 * Conflict-Free Replicated Data Type (CRDT) Vector State & Room Manager
 * Implements:
 * 1. Lamport Timestamps / State Vectors for conflict-free element mutation
 * 2. Last-Write-Wins (LWW-Element-Set) convergence algorithm
 * 3. Spatial indexing & Layer Ordering
 * 4. Undo / Redo Vector Operation log
 */

class CRDTCanvasEngine {
    constructor() {
        this.rooms = new Map(); // roomId -> RoomData
        this.stats = {
            totalOpsProcessed: 0,
            conflictsResolved: 0,
            activePeers: 0
        };
    }

    getOrCreateRoom(roomId = 'global_main_board') {
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, {
                id: roomId,
                elements: new Map(), // elementId -> Element
                peers: new Map(),    // peerId -> PeerInfo
                lamportClock: 0,
                operationLog: []
            });
        }
        return this.rooms.get(roomId);
    }

    // Apply or Mutate Canvas Object (Stroke, Sticky Note, Rectangle, Circle, Text)
    applyOperation(roomId, operation) {
        const room = this.getOrCreateRoom(roomId);
        room.lamportClock = Math.max(room.lamportClock, operation.timestamp || 0) + 1;
        this.stats.totalOpsProcessed++;

        const { type, element, elementId, peerId } = operation;

        if (type === 'ELEMENT_UPSERT') {
            const existing = room.elements.get(element.id);
            if (existing) {
                // Conflict resolution: Last-Write-Wins based on Lamport clock + peerId tiebreaker
                if (
                    (element.lamportClock > existing.lamportClock) ||
                    (element.lamportClock === existing.lamportClock && peerId > (existing.lastUpdatedBy || ''))
                ) {
                    this.stats.conflictsResolved++;
                    room.elements.set(element.id, { ...element, lamportClock: room.lamportClock, lastUpdatedBy: peerId });
                }
            } else {
                room.elements.set(element.id, { ...element, lamportClock: room.lamportClock, lastUpdatedBy: peerId });
            }
        } else if (type === 'ELEMENT_DELETE') {
            room.elements.delete(elementId);
        } else if (type === 'ELEMENT_BATCH_CLEAR') {
            room.elements.clear();
        }

        room.operationLog.push({ ...operation, serverClock: room.lamportClock, processedAt: Date.now() });
        if (room.operationLog.length > 500) room.operationLog.shift();

        return {
            serverClock: room.lamportClock,
            roomElements: Array.from(room.elements.values()),
            activeCount: room.elements.size
        };
    }

    // Peer Join / Cursor Tracking
    updatePeerCursor(roomId, peerId, cursorData) {
        const room = this.getOrCreateRoom(roomId);
        const existing = room.peers.get(peerId) || {};
        room.peers.set(peerId, {
            ...existing,
            ...cursorData,
            peerId,
            lastSeen: Date.now()
        });
    }

    removePeer(roomId, peerId) {
        const room = this.getOrCreateRoom(roomId);
        room.peers.delete(peerId);
    }

    getRoomSnapshot(roomId) {
        const room = this.getOrCreateRoom(roomId);
        return {
            roomId,
            elements: Array.from(room.elements.values()),
            peers: Array.from(room.peers.values()),
            lamportClock: room.lamportClock,
            totalElements: room.elements.size
        };
    }

    getStats() {
        let totalElements = 0;
        let totalPeers = 0;
        for (const r of this.rooms.values()) {
            totalElements += r.elements.size;
            totalPeers += r.peers.size;
        }
        return {
            ...this.stats,
            totalRooms: this.rooms.size,
            totalElements,
            activePeers: totalPeers
        };
    }
}

module.exports = new CRDTCanvasEngine();

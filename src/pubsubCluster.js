/**
 * Distributed Redis Pub/Sub Cluster Sim
 * Simulates multiple WebSocket server cluster nodes communicating across redis channels
 */

const EventEmitter = require('events');

class RedisPubSubCluster extends EventEmitter {
    constructor() {
        super();
        this.channels = new Map();
        this.stats = {
            messagesPublished: 0,
            channelSubscribers: 0
        };
    }

    subscribe(channel, callback) {
        if (!this.channels.has(channel)) {
            this.channels.set(channel, new Set());
        }
        this.channels.get(channel).add(callback);
        this.stats.channelSubscribers++;
    }

    unsubscribe(channel, callback) {
        if (this.channels.has(channel)) {
            this.channels.get(channel).delete(callback);
            this.stats.channelSubscribers = Math.max(0, this.stats.channelSubscribers - 1);
        }
    }

    publish(channel, message) {
        this.stats.messagesPublished++;
        if (this.channels.has(channel)) {
            for (const cb of this.channels.get(channel)) {
                try {
                    cb(message);
                } catch (e) {
                    console.error('PubSub callback error:', e);
                }
            }
        }
    }

    getStats() {
        return {
            ...this.stats,
            activeChannels: this.channels.size
        };
    }
}

module.exports = new RedisPubSubCluster();

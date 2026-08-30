import { useCallback, useEffect, useRef, useState } from 'react';
import type { LanDrawingStroke, LanWhiteboardClientMessage, LanWhiteboardServerMessage, LanWhiteboardSnapshot } from '../../../shared/lanWhiteboard';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'invalid';

interface SocketState {
  clientCount: number;
  latency?: number;
  lastAcknowledgement?: { requestId: string; canvasId?: string };
  snapshot?: LanWhiteboardSnapshot;
  status: ConnectionStatus;
  trusted: boolean;
  transientStrokes: Record<string, Record<string, LanDrawingStroke>>;
}

const trustedCredentialKey = 'tessel.lan-whiteboard.trusted-credential';
const trustedDeviceIdKey = 'tessel.lan-whiteboard.device-id';

export function useLanWhiteboardSocket(token: string): SocketState & {
  send(message: LanWhiteboardClientMessage): boolean;
  trustDevice(): boolean;
} {
  const socketRef = useRef<WebSocket>();
  const retryRef = useRef(0);
  const pendingRef = useRef<LanWhiteboardClientMessage[]>([]);
  const [state, setState] = useState<SocketState>({
    clientCount: 0,
    status: token || readTrustedCredential() ? 'connecting' : 'invalid',
    trusted: Boolean(readTrustedCredential()),
    transientStrokes: {}
  });

  useEffect(() => {
    const trustedCredential = readTrustedCredential();
    if (!token && !trustedCredential) {
      return;
    }
    let disposed = false;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;

    const connect = (): void => {
      if (disposed) {
        return;
      }
      setState((current) => ({ ...current, status: 'connecting' }));
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const query = new URLSearchParams();
      if (token) {
        query.set('token', token);
      }
      const credential = readTrustedCredential();
      if (credential) {
        query.set('trust', credential);
      }
      const socket = new WebSocket(`${protocol}//${location.host}/whiteboard?${query}`);
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        retryRef.current = 0;
        setState((current) => ({ ...current, status: 'connected' }));
        for (const pending of pendingRef.current.splice(0)) {
          socket.send(JSON.stringify(pending));
        }
        const ping = (): void => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping', sentAt: Date.now() } satisfies LanWhiteboardClientMessage));
          }
        };
        ping();
        pingTimer = window.setInterval(ping, 2_000);
      });
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as LanWhiteboardServerMessage;
          if (message.type === 'device-trusted') {
            localStorage.setItem(trustedCredentialKey, message.credential);
          }
          applyMessage(message, setState);
        } catch (error) {
          console.warn('Ignored malformed Tessel whiteboard message', error);
        }
      });
      socket.addEventListener('close', (event) => {
        if (pingTimer !== undefined) {
          window.clearInterval(pingTimer);
        }
        if (disposed) {
          return;
        }
        setState((current) => ({ ...current, status: event.code === 1008 ? 'invalid' : 'disconnected' }));
        if (event.code === 1008 && readTrustedCredential()) {
          localStorage.removeItem(trustedCredentialKey);
          setState((current) => ({ ...current, trusted: false }));
        }
        if (event.code !== 1008) {
          const delay = Math.min(3_000, 180 * 2 ** retryRef.current);
          retryRef.current += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        }
      });
      socket.addEventListener('error', () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (pingTimer !== undefined) {
        window.clearInterval(pingTimer);
      }
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [token]);

  const send = useCallback((message: LanWhiteboardClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (isDurableMessage(message)) {
        pendingRef.current.push(message);
        if (pendingRef.current.length > 100) {
          pendingRef.current.shift();
        }
      }
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const trustDevice = useCallback((): boolean => {
    let deviceId = localStorage.getItem(trustedDeviceIdKey)?.trim();
    if (!deviceId) {
      deviceId = globalThis.crypto?.randomUUID?.() ?? `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(trustedDeviceIdKey, deviceId);
    }
    return send({ type: 'trust-device', requestId: `trust_${Date.now().toString(36)}`, deviceId });
  }, [send]);

  return { ...state, send, trustDevice };
}

function isDurableMessage(message: LanWhiteboardClientMessage): boolean {
  return message.type === 'create-canvas'
    || message.type === 'delete-canvas'
    || message.type === 'move-canvas'
    || message.type === 'set-pen-only'
    || message.type === 'stroke-commit'
    || message.type === 'replace-strokes';
}

function applyMessage(message: LanWhiteboardServerMessage, setState: React.Dispatch<React.SetStateAction<SocketState>>): void {
  switch (message.type) {
    case 'snapshot':
      setState((current) => ({ ...current, snapshot: message.snapshot, transientStrokes: {} }));
      return;
    case 'context':
      setState((current) => current.snapshot ? {
        ...current,
        snapshot: { ...current.snapshot, context: message.context }
      } : current);
      return;
    case 'canvas-upsert':
      setState((current) => current.snapshot ? {
        ...current,
        snapshot: {
          ...current.snapshot,
          revision: message.revision,
          canvases: [message.block, ...current.snapshot.canvases.filter((block) => block.id !== message.block.id)]
        }
      } : current);
      return;
    case 'canvas-delete':
      setState((current) => current.snapshot ? {
        ...current,
        snapshot: {
          ...current.snapshot,
          revision: message.revision,
          canvases: current.snapshot.canvases.filter((block) => block.id !== message.blockId)
        }
      } : current);
      return;
    case 'selection-share':
      return;
    case 'stroke-begin':
      setState((current) => ({
        ...current,
        transientStrokes: {
          ...current.transientStrokes,
          [message.canvasId]: {
            ...current.transientStrokes[message.canvasId],
            [message.stroke.id]: message.stroke
          }
        }
      }));
      return;
    case 'stroke-points':
      setState((current) => {
        const stroke = current.transientStrokes[message.canvasId]?.[message.strokeId];
        if (!stroke) {
          return current;
        }
        return {
          ...current,
          transientStrokes: {
            ...current.transientStrokes,
            [message.canvasId]: {
              ...current.transientStrokes[message.canvasId],
              [message.strokeId]: { ...stroke, points: [...stroke.points, ...message.points] }
            }
          }
        };
      });
      return;
    case 'stroke-cancel':
      setState((current) => {
        const canvasStrokes = { ...current.transientStrokes[message.canvasId] };
        delete canvasStrokes[message.strokeId];
        return {
          ...current,
          transientStrokes: { ...current.transientStrokes, [message.canvasId]: canvasStrokes }
        };
      });
      return;
    case 'presence':
      setState((current) => ({ ...current, clientCount: message.clientCount }));
      return;
    case 'device-trusted':
      setState((current) => ({ ...current, trusted: true }));
      return;
    case 'pong':
      setState((current) => ({ ...current, latency: Math.max(0, Date.now() - message.sentAt) }));
      return;
    case 'error':
      console.warn(`Tessel whiteboard: ${message.message}`);
      return;
    case 'ack':
      setState((current) => ({
        ...current,
        lastAcknowledgement: { requestId: message.requestId, canvasId: message.canvasId }
      }));
      return;
  }
}

function readTrustedCredential(): string {
  try {
    return localStorage.getItem(trustedCredentialKey)?.trim() ?? '';
  } catch {
    return '';
  }
}

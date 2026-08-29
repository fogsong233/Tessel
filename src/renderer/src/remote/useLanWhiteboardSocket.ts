import { useCallback, useEffect, useRef, useState } from 'react';
import type { LanDrawingStroke, LanWhiteboardClientMessage, LanWhiteboardServerMessage, LanWhiteboardSnapshot } from '../../../shared/lanWhiteboard';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'invalid';

interface SocketState {
  clientCount: number;
  latency?: number;
  snapshot?: LanWhiteboardSnapshot;
  status: ConnectionStatus;
  transientStrokes: Record<string, Record<string, LanDrawingStroke>>;
}

export function useLanWhiteboardSocket(token: string): SocketState & { send(message: LanWhiteboardClientMessage): boolean } {
  const socketRef = useRef<WebSocket>();
  const retryRef = useRef(0);
  const pendingRef = useRef<LanWhiteboardClientMessage[]>([]);
  const [state, setState] = useState<SocketState>({
    clientCount: 0,
    status: token ? 'connecting' : 'invalid',
    transientStrokes: {}
  });

  useEffect(() => {
    if (!token) {
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
      const socket = new WebSocket(`${protocol}//${location.host}/whiteboard?token=${encodeURIComponent(token)}`);
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
          applyMessage(JSON.parse(String(event.data)) as LanWhiteboardServerMessage, setState);
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

  return { ...state, send };
}

function isDurableMessage(message: LanWhiteboardClientMessage): boolean {
  return message.type === 'create-canvas'
    || message.type === 'delete-canvas'
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
    case 'pong':
      setState((current) => ({ ...current, latency: Math.max(0, Date.now() - message.sentAt) }));
      return;
    case 'error':
      console.warn(`Tessel whiteboard: ${message.message}`);
      return;
    case 'ack':
      return;
  }
}

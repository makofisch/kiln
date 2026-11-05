import type { ServerEvent } from '../../shared/types.ts';

/**
 * Kiln's live updates over a WebSocket (reconnecting on its own). Not Server-Sent Events: Chromium
 * allows only six HTTP connections to one host across all of the app's windows, and open event
 * streams used them up (see src/core/ws.ts).
 */
export function openLive(projectId: string | null, handlers: { onEvent: (e: ServerEvent) => void; onOpen?: () => void; onDown?: () => void }): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let delay = 400;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const embed = new URLSearchParams(location.search).get('embed');
    const q = [projectId ? `project=${encodeURIComponent(projectId)}` : '', embed ? `embed=${encodeURIComponent(embed)}` : ''].filter(Boolean).join('&');
    const url = `${proto}//${location.host}/api/v1/ws${q ? `?${q}` : ''}`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      delay = 400;
      handlers.onOpen?.();
    };
    sock.onmessage = (m) => {
      try {
        handlers.onEvent(JSON.parse(m.data as string) as ServerEvent);
      } catch (err) {
        console.error(err);
      }
    };
    sock.onclose = () => {
      if (ws !== sock || stopped) return;
      handlers.onDown?.();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 4000);
    };
  };
  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}

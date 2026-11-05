// The Kiln core: runs in an Electron utilityProcess (desktop app) or plain Node (development).
import { logCore } from './fsx.ts';
import { startServer, watchExternal } from './server.ts';

// A bug in one request or timer must not take every open project down with it: log it and carry on.
process.on('uncaughtException', (e) => logCore(`uncaught exception: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => logCore(`unhandled rejection: ${(e as Error)?.stack ?? e}`));

const { port, token, imported, stop } = await startServer();

type ParentPort = { postMessage(m: unknown): void; on(ev: 'message', fn: (e: { data: unknown }) => void): void };
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent) {
  parent.postMessage({ type: 'ready', port, imported });
  watchExternal((active) => parent.postMessage({ type: 'external', active }));
  parent.on('message', (e) => {
    if ((e.data as { type?: string })?.type === 'shutdown') {
      stop();
      setTimeout(() => process.exit(0), 400);
    }
  });
} else {
  console.log(`Kiln core on http://127.0.0.1:${port}/auth?t=${token}&next=/`);
}

const quit = () => {
  stop();
  setTimeout(() => process.exit(0), 400);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

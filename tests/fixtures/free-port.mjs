// A port for a test server that cannot collide with another test process: asks the OS, which hands out a free one, then keeps it for this server.
import net from 'node:net';
export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => resolve(port)); });
});

import { createApp } from './app.ts';
import { pathToFileURL } from 'node:url';
import { createNodeUpstreamTransport } from './node-upstream.ts';
export { createApp } from './app.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const upstream = createNodeUpstreamTransport();
const application = createApp({ upstreamFetch: upstream.fetch });
const server = application.app.listen(port, host, () => {
  console.log(`Model Lab 已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log('首次管理口令保存在数据目录的 admin-token 文件中（或使用 ADMIN_TOKEN 环境变量）。');
});
async function shutdown() {
  server.close();
  await application.close();
  await upstream.close();
  server.closeAllConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.on('error', async () => { console.error('服务启动失败，请检查监听地址和端口。'); await application.close(); await upstream.close(); process.exitCode = 1; });
}

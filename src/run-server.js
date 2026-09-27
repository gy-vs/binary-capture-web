'use strict';

import { createServer } from './server.js';

const port = Number(process.env.PORT || 8080);
const server = createServer();
server.listen(port, () => {
  console.log(`二进制抓包重组工作台已启动: http://localhost:${port}`);
});

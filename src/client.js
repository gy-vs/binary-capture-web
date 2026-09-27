// 消费端：保持“当前会话 + 方向 + 版本”的选择，迟到的查询响应不得覆盖较新的视图。
//
// 防护规则：
//   - 每个请求带单调递增 token，服务端原样回显
//   - SessionView 维护 generation：每次 import / 切换选择都会推进
//   - 响应回来时若 token 已过期，则挂到 stale[] 并返回 { stale: true }，由调用方决定忽略
//   - 调用方也可以按 revision 判断（响应头 x-session-revision）

export class WorkbenchClient {
  constructor(baseUrl = 'http://localhost:8080', { fetchImpl } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl ?? fetch;
    this._token = 0;
  }

  nextToken() {
    this._token += 1;
    return `t${Date.now().toString(36)}_${this._token}`;
  }

  async _request(method, path, body) {
    const token = this.nextToken();
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-request-token': token },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json();
    return {
      status: res.status,
      token,
      revision: res.headers.get('x-session-revision') !== null
        ? Number(res.headers.get('x-session-revision'))
        : json.revision ?? null,
      body: json
    };
  }

  async createSession(opts = {}) {
    const r = await this._request('POST', '/sessions/create', opts);
    if (r.status !== 201) throw new Error(r.body.error || '创建会话失败');
    return new SessionView(this, r.body.sessionId);
  }

  listSessions() {
    return this._request('GET', '/sessions');
  }

  openSession(sessionId) {
    return new SessionView(this, sessionId);
  }
}

export class SessionView {
  constructor(client, sessionId) {
    this.client = client;
    this.sessionId = sessionId;
    this.direction = 0;
    this.version = null; // null = 会话默认版本
    this.generation = 0; // 每次导入/切换选择推进
    this.lastRevision = null;
    this.stale = []; // 被丢弃的迟到响应（便于测试与排障）
  }

  select({ direction, version } = {}) {
    if (direction !== undefined && direction !== this.direction) {
      this.direction = Number(direction);
      this.generation += 1;
    }
    if (version !== undefined && version !== this.version) {
      this.version = version;
      this.generation += 1;
    }
    return { direction: this.direction, version: this.version, generation: this.generation };
  }

  // 守卫请求：发起时记下 (generation, token)；返回时若已过期则标记 stale。
  async _guarded(kind, make) {
    const gen = this.generation;
    const token = this.client.nextToken();
    const envelope = await make(token);
    const current = gen === this.generation && envelope.token === token;
    if (!current) {
      const dropped = { kind, token, sentAtGeneration: gen, currentGeneration: this.generation, body: envelope.body };
      this.stale.push(dropped);
      return { stale: true, dropped };
    }
    if (envelope.revision !== null) this.lastRevision = envelope.revision;
    return { stale: false, ...envelope.body, revision: envelope.revision };
  }

  async _send(method, path, body, token) {
    const res = await this.client.fetchImpl(this.client.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-request-token': token },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json();
    return {
      status: res.status,
      token: res.headers.get('x-request-token') ?? token,
      revision: res.headers.get('x-session-revision') !== null
        ? Number(res.headers.get('x-session-revision'))
        : (json.revision ?? null),
      body: json
    };
  }

  _p(path) {
    const hasQuery = path.includes('?');
    const v = this.version ? `${hasQuery ? '&' : '?'}version=${encodeURIComponent(this.version)}` : '';
    return `/sessions/${this.sessionId}/directions/${this.direction}/${path}${v}`;
  }

  async importFragments(fragments, { delayMs = 0 } = {}) {
    // 导入使一切在途查询过期
    const gen = this.generation;
    const token = this.client.nextToken();
    const res = await this.client.fetchImpl(
      `${this.client.baseUrl}/sessions/${this.sessionId}/fragments${delayMs ? `?delayMs=${delayMs}` : ''}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-token': token },
        body: JSON.stringify({ fragments })
      }
    );
    const json = await res.json();
    this.generation += 1;
    if (typeof json.revision === 'number') this.lastRevision = json.revision;
    return { token, sentAtGeneration: gen, generation: this.generation, ...json };
  }

  progress({ delayMs = 0 } = {}) {
    return this._guarded('progress',
      (token) => this._send('GET', `/sessions/${this.sessionId}?delayMs=${delayMs}`, undefined, token));
  }

  messages({ limit = 256, offset = 0, fields = false, delayMs = 0 } = {}) {
    return this._guarded('messages',
      (token) => this._send('GET',
        `${this._p(`messages?limit=${limit}&offset=${offset}&fields=${fields}&delayMs=${delayMs}`)}`, undefined, token));
  }

  message(index, { delayMs = 0 } = {}) {
    return this._guarded('message',
      (token) => this._send('GET', `${this._p(`messages/${index}?delayMs=${delayMs}`)}`, undefined, token));
  }

  errors({ limit = 256, offset = 0, delayMs = 0 } = {}) {
    return this._guarded('errors',
      (token) => this._send('GET', `${this._p(`errors?limit=${limit}&offset=${offset}&delayMs=${delayMs}`)}`, undefined, token));
  }

  errorBytes(index, { limit = 128, offset = 0, delayMs = 0 } = {}) {
    return this._guarded('errorBytes',
      (token) => this._send('GET', `${this._p(`errors/${index}/bytes?limit=${limit}&offset=${offset}&delayMs=${delayMs}`)}`, undefined, token));
  }

  range({ start = 0, end, limit = 256, format = 'hex', delayMs = 0 } = {}) {
    const e = end === undefined ? '' : `end=${end}&`;
    return this._guarded('range',
      (token) => this._send('GET', `${this._p(`range?start=${start}&${e}limit=${limit}&format=${format}&delayMs=${delayMs}`)}`, undefined, token));
  }

  locate(offset, { delayMs = 0 } = {}) {
    return this._guarded('locate',
      (token) => this._send('GET', `${this._p(`locate/${offset}?delayMs=${delayMs}`)}`, undefined, token));
  }

  boundaries({ delayMs = 0 } = {}) {
    return this._guarded('boundaries',
      (token) => this._send('GET', `${this._p(`boundaries?delayMs=${delayMs}`)}`, undefined, token));
  }

  fragments({ delayMs = 0 } = {}) {
    return this._guarded('fragments',
      (token) => this._send('GET', `${this._p(`fragments?delayMs=${delayMs}`)}`, undefined, token));
  }

  compare(versions, { delayMs = 0 } = {}) {
    const vs = versions ? versions.map(encodeURIComponent).join(',') : '';
    return this._guarded('compare',
      (token) => this._send('GET', `${this._p(`compare?${vs ? `versions=${vs}&` : ''}delayMs=${delayMs}`)}`, undefined, token));
  }
}

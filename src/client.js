'use strict';

// ---------------------------------------------------------------------------
// client.js —— 工作台 HTTP 客户端（只用全局 fetch，Node 20 内置）。
//
// 解决题目里的两个现场问题：
//  1. “切换视图不能把另一版本的解析结果混进来”：所有查询绑定当前 viewId，
//     并用守卫代(generation)标记；切换会话/视图后，在途旧查询的响应直接丢弃；
//  2. “服务端查询可能比新的补片请求更晚返回”：导入后提升 revision 水位，
//     响应里的 sessionRevision 低于水位时按过期处理（可选，调用方决定重试或丢弃）。
// ---------------------------------------------------------------------------

export class StaleResponseError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'StaleResponseError';
    this.meta = meta;
  }
}

export class WorkbenchClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sessionId = null;
    this.viewId = null;
    this._generation = 0; // 每次切换会话/视图递增，在途响应据此作废
    this._revisionWatermark = 0;
    this._nextQueryDelay = 0; // 下一次查询的服务端延迟（模拟慢返回）
  }

  // --- 选择 ---

  async createSession(options = {}) {
    const s = await this._post('/sessions', options);
    this.selectSession(s.id);
    return s;
  }

  selectSession(sessionId) {
    this.sessionId = sessionId;
    this.viewId = null;
    this._generation += 1;
    this._revisionWatermark = 0;
  }

  async createView(viewOptions = {}) {
    this._requireSession();
    const v = await this._post(`/sessions/${this.sessionId}/views`, viewOptions);
    this.selectView(v.viewId);
    return v;
  }

  selectView(viewId) {
    this.viewId = viewId;
    this._generation += 1; // 旧版本视图的在途结果作废
  }

  getSelection() {
    return { sessionId: this.sessionId, viewId: this.viewId, generation: this._generation };
  }

  // --- 写入（提升修订水位） ---

  async importSegments(segments) {
    this._requireSession();
    const result = await this._post(`/sessions/${this.sessionId}/segments`, { segments });
    this._revisionWatermark = Math.max(this._revisionWatermark, result.revision);
    return result;
  }

  // --- 受当前选择保护的查询 ---

  async progress(direction) {
    return this._guarded(`/views/${this._v()}/${direction}/progress`);
  }

  async messages(direction, params = {}) {
    return this._guarded(`/views/${this._v()}/${direction}/messages`, params);
  }

  async errors(direction, params = {}) {
    return this._guarded(`/views/${this._v()}/${direction}/errors`, params);
  }

  async boundary(direction, params = {}) {
    return this._guarded(`/views/${this._v()}/${direction}/boundary`, params);
  }

  async locate(direction, offset) {
    return this._guarded(`/views/${this._v()}/${direction}/locate`, { offset });
  }

  async locateDatagram(direction, datagramIndex, offset) {
    return this._guarded(`/views/${this._v()}/${direction}/datagrams/${datagramIndex}/locate`, { offset });
  }

  async bytes(direction, start, end, extra = {}) {
    return this._guarded(`/views/${this._v()}/${direction}/bytes/range`, { start, end, ...extra });
  }

  async datagramBytes(direction, datagramIndex, start, end) {
    return this._guarded(
      `/views/${this._v()}/${direction}/datagrams/${datagramIndex}/bytes/range`,
      { start, end }
    );
  }

  async messageBytes(direction, messageId) {
    return this._guarded(`/views/${this._v()}/${direction}/messages/${messageId}/bytes`);
  }

  async errorBytes(direction, errorIndex, params = {}) {
    return this._guarded(`/views/${this._v()}/${direction}/errors/${errorIndex}`, params);
  }

  async listSegments(direction) {
    this._requireSession();
    return this._get(`/sessions/${this.sessionId}/segments`, direction ? { direction } : {});
  }

  async segmentBytes(segId, start, end) {
    return this._get(`/sessions/${this.sessionId}/segments/${segId}/bytes`, { start, end });
  }

  // --- 内部 ---

  _v() {
    if (!this.viewId) throw new Error('尚未选择视图，请先 createView/selectView');
    return this.viewId;
  }

  _requireSession() {
    if (!this.sessionId) throw new Error('尚未选择会话');
  }

  // 守卫查询：发请求时记住当前世代；返回时若已切换，拒绝把旧结果交给调用方
  async _guarded(path, params = {}, { acceptStaleRevision = false } = {}) {
    const gen = this._generation;
    const view = this.viewId;
    const queryParams = this._nextQueryDelay ? { ...params, _delay: this._nextQueryDelay } : params;
    this._nextQueryDelay = 0;
    const result = await this._get(path, queryParams);
    if (gen !== this._generation || view !== this.viewId) {
      throw new StaleResponseError('查询返回时选择已切换，丢弃过期视图结果', {
        issuedGeneration: gen,
        currentGeneration: this._generation,
        issuedView: view,
        currentView: this.viewId
      });
    }
    const rev = result.view?.caughtUpRev;
    if (!acceptStaleRevision && typeof rev === 'number' && rev < this._revisionWatermark) {
      throw new StaleResponseError('查询基于补片之前的修订，已过期', {
        revision: rev,
        watermark: this._revisionWatermark
      });
    }
    return result;
  }

  // 让下一次查询在服务端延迟指定毫秒（模拟“查询比新补丁更晚返回”）
  delayNextQuery(ms) {
    this._nextQueryDelay = ms;
    return this;
  }

  async _get(path, params = {}) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    const res = await fetch(u);
    return this._handle(res);
  }

  async _post(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return this._handle(res);
  }

  async _handle(res) {
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
}

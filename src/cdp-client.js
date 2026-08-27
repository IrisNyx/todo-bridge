/**
 * cdp-client.js — Chrome DevTools Protocol 客户端
 * 
 * 连接 Electron 应用的调试端口，注入 JavaScript 操作其内部状态。
 * 这是一个通用 CDP 客户端，不绑定特定 App。
 */
const http = require('http');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class CdpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.port - CDP 调试端口 (默认 9222)
   * @param {string} opts.host - 主机 (默认 127.0.0.1)
   * @param {number} opts.timeout - 连接超时 (ms, 默认 10000)
   */
  constructor(opts = {}) {
    super();
    this.port = opts.port || 9222;
    this.host = opts.host || '127.0.0.1';
    this.timeout = opts.timeout || 10000;
    this.ws = null;
    this._msgId = 1;
    this._pendingResolves = new Map();
    this._connected = false;
  }

  /**
   * 发现可调试的页面目标
   * @returns {Promise<Array>} 页面列表
   */
  async listTargets() {
    const url = `http://${this.host}:${this.port}/json`;
    const resp = await this._fetch(url);
    return JSON.parse(resp);
  }

  /**
   * 连接到特定页面目标，返回 WebSocket URL
   * @param {string} targetFilter - 如果传，匹配 URL 关键字
   * @returns {Promise<string>} webSocketDebuggerUrl
   */
  async connectTarget(targetFilter) {
    const targets = await this.listTargets();
    let target;

    if (targetFilter) {
      target = targets.find(t => t.url && t.url.includes(targetFilter));
    }

    // 优先找 Page 类型或 url 非空的目标
    if (!target) {
      target = targets.find(t => t.type === 'page' && t.url && t.url !== 'about:blank');
    }
    if (!target) {
      target = targets.find(t => t.type === 'page');
    }
    if (!target) {
      target = targets[0];
    }

    if (!target) {
      throw new Error('没有发现可调试的目标页面');
    }

    return target.webSocketDebuggerUrl;
  }

  /**
   * 连接到 Electron 应用
   * @param {string} targetFilter - URL 关键字过滤
   */
  async connect(targetFilter) {
    const wsUrl = await this.connectTarget(targetFilter);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`CDP 连接超时 (${this.timeout}ms)`));
      }, this.timeout);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this._connected = true;
        console.log(`[CDP] 已连接: ${wsUrl}`);
        resolve();
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data);
      });

      this.ws.on('close', () => {
        this._connected = false;
        // 拒绝所有挂起的请求
        for (const [id, { reject: rej }] of this._pendingResolves) {
          rej(new Error('CDP 连接已关闭'));
        }
        this._pendingResolves.clear();
        this.emit('disconnected');
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this._connected = false;
        reject(err);
      });
    });
  }

  /** 发送 CDP 命令并等待响应 */
  async send(method, params = {}) {
    if (!this._connected || !this.ws) {
      throw new Error('CDP 未连接');
    }

    const id = this._msgId++;
    const msg = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // 超时也清理
        this._pendingResolves.delete(id);
        reject(new Error(`CDP 命令超时: ${method} (id=${id})`));
      }, this.timeout);

      this._pendingResolves.set(id, { resolve, reject, timeout });
      this.ws.send(msg);
    });
  }

  /**
   * 在目标页面中执行 JavaScript
   * @param {string} code - 要执行的 JS 代码
   * @param {boolean} awaitPromise - 是否等待 Promise 完成
   * @returns {Promise<any>} 执行结果
   */
  async evaluate(code, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression: code,
      awaitPromise,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`JS 执行错误: ${desc}`);
    }

    return result.result?.value;
  }

  /** 获取一个值的完整对象（当 returnByValue 不够时） */
  async evaluateFull(code) {
    // 先 evaluate
    const result = await this.send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: false,
    });

    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`JS 执行错误: ${desc}`);
    }

    if (!result.result || !result.result.objectId) {
      return result.result?.value;
    }

    // 用 Runtime.getProperties 获取完整属性
    const props = await this.send('Runtime.getProperties', {
      objectId: result.result.objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
    });

    const obj = {};
    for (const prop of props.result || []) {
      if (prop.value && prop.value.value !== undefined) {
        obj[prop.name] = prop.value.value;
      } else if (prop.value && prop.value.objectId) {
        obj[prop.name] = `[object ${prop.value.className || '?'}]`;
      }
    }
    return obj;
  }

  /** 断开连接 */
  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
    }
    this._connected = false;
  }

  // ─── internal ───

  _handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString());
      // CDP 响应
      if (msg.id !== undefined) {
        const pending = this._pendingResolves.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this._pendingResolves.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`CDP 错误: ${JSON.stringify(msg.error)}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
      // CDP 事件
      else if (msg.method) {
        this.emit(msg.method, msg.params);
      }
    } catch (e) {
      console.error('[CDP] 消息解析失败:', e.message);
    }
  }

  _fetch(url) {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
}

module.exports = { CdpClient };

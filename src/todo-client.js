'use strict';
const CDP = require('chrome-remote-interface');
const DEFAULT_PORT = 9222;
const TARGET_URL_PATTERN = '#/todo-list/today';
const VUEX_EXPR = "(function(){var el=document.querySelector('#app')||document.querySelector('[data-v-]');if(!el)return null;var vm=el.__vue__;return vm&&vm.$store;})()";

// ─── 时间戳工具（Node 侧，本地时区）──────────────────
function parseLocalTs(s) {
  // 'YYYY-MM-DD' | 'YYYY-MM-DD HH:MM[:SS]' | 'YYYY-MM-DDTHH:MM[:SS]' → 本地时区 ms
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2})(?::\d{2})?)?$/.exec(String(s).trim());
  if (m) return new Date(m[1] + 'T' + (m[2] || '00:00') + ':00').getTime();
  return new Date(s).getTime();
}
function toPlanTs(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  return parseLocalTs(v);
}
// to 用：只传日期时取当日 23:59:59.999（闭区间）
function toEndTs(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d{4}-\d{2}-\d{2})$/.exec(String(v).trim());
  if (m) return new Date(m[1] + 'T23:59:59.999').getTime();
  return parseLocalTs(v);
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// reminderTime：纯 "HH:MM" 时与 date（缺省今天）合成完整时间戳
function toReminderTs(v, dateStr) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const s = String(v).trim();
  const tm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (tm) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
    return new Date(day + 'T' + tm[1] + ':' + tm[2] + ':00').getTime();
  }
  return parseLocalTs(s);
}

class TodoClient {
  constructor(opts) {
    this._host = (opts && opts.host) || '127.0.0.1';
    this._port = (opts && opts.cdpPort) || DEFAULT_PORT;
    this._timeout = (opts && opts.timeout) || 15000;
    this._client = null;
    this._targets = [];
  }
  _withTimeout(promise, msg) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(msg || 'timeout')), this._timeout);
      promise.then(
        (v) => { clearTimeout(to); resolve(v); },
        (e) => { clearTimeout(to); reject(e); }
      );
    });
  }
  async connect() {
    if (this._client) await this.close(); // 重复 connect 先关旧连接
    this._targets = await this._withTimeout(
      CDP.List({ host: this._host, port: this._port }),
      'CDP.List timeout. Is Todo running with --remote-debugging-port?'
    );
    if (!this._targets || !this._targets.length)
      throw new Error('No CDP targets. Is Todo running with --remote-debugging-port?');
    var target = this._pickTarget();
    if (!target)
      throw new Error('Main page not found. Targets: ' + JSON.stringify(this._targets.map((t) => t.url)));
    this._client = await this._withTimeout(
      CDP({ target: target, host: this._host, port: this._port }),
      'CDP connect timeout'
    );
    await Promise.all([this._client.Runtime.enable(), this._client.Page.enable()]);
    // store 未就绪时轮询（最多 5 次 × 500ms），仍不行则交给业务方法返回 {__error__:'no store'}
    await this._waitForStore();
    return this;
  }
  async _waitForStore() {
    for (var i = 0; i < 5; i++) {
      const ok = await this._eval("(function(){var s=" + VUEX_EXPR + ";return !!(s&&s.state&&s.state.todo);})()");
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  _pickTarget() {
    for (var i = 0; i < this._targets.length; i++) {
      var t = this._targets[i];
      if (t.type === 'page' && t.url && t.url.indexOf(TARGET_URL_PATTERN) !== -1) return t;
    }
    for (var j = 0; j < this._targets.length; j++)
      if (this._targets[j].type === 'page') return this._targets[j];
    return null;
  }
  async close() {
    if (this._client) { try { await this._client.close(); } catch (e) {} this._client = null; }
  }
  async _eval(expr, awaitPromise) {
    if (!this._client) throw new Error('Not connected. Call connect() first.');
    var r = await this._client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) {
      var ed = r.exceptionDetails;
      var desc = (ed.exception && ed.exception.description) || ed.text || JSON.stringify(ed);
      throw new Error('Eval error: ' + desc);
    }
    return r.result ? r.result.value : undefined;
  }
  async ping() {
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";" +
      "if(!s)return{connected:false,error:'no store'};" +
      "var todoList=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "return{connected:true,totalTodos:todoList.length," +
      "activeTodos:todoList.filter(function(t){return !t.delete&&!t.complete}).length," +
      "categories:(s.state.category&&s.state.category.list?s.state.category.list.map(function(c){return{id:c.categoryId,name:c.categoryName,color:c.categoryColor}}):[])," +
      "userId:s.state.auth&&s.state.auth.user&&s.state.auth.user.id}" +
      "})()"
    );
  }
  async getCategories() {
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "return JSON.parse(JSON.stringify(s.state.category&&s.state.category.list||[]));" +
      "})()"
    );
  }
  async getTodos(filter) {
    filter = filter || {};
    var f = {};
    if (filter.categoryId != null) f.categoryId = parseInt(filter.categoryId);
    if (filter.active) f.active = true;
    if (filter.includeDeleted) f.includeDeleted = true;
    if (filter.noDate) f.noDate = true;
    if (filter.limit != null) f.limit = parseInt(filter.limit) || 0;
    if (filter.date) f.date = String(filter.date);
    if (filter.reminderDate) f.reminderDate = String(filter.reminderDate);
    if (filter.from != null) f.from = toPlanTs(filter.from);
    if (filter.to != null) f.to = toEndTs(filter.to);
    if (filter.reminderFrom != null) f.reminderFrom = toPlanTs(filter.reminderFrom);
    if (filter.reminderTo != null) f.reminderTo = toEndTs(filter.reminderTo);
    var fs = JSON.stringify(f);
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "var arr=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "var f=" + fs + ";" +
      "if(!f.includeDeleted)arr=arr.filter(function(t){return !t.delete});" +
      "if(f.categoryId!=null)arr=arr.filter(function(t){return t.standbyInt1===f.categoryId||t.categoryId===f.categoryId});" +
      "if(f.active)arr=arr.filter(function(t){return !t.delete&&!t.complete});" +
      "if(f.noDate)arr=arr.filter(function(t){return !t.todoTime&&!t.dayStart});" +
      "if(f.date)arr=arr.filter(function(t){var st=new Date(f.date+'T00:00:00').getTime();var dk=t.dayStart||t.todoTime||0;return dk>=st&&dk<st+86400000});" +
      "if(f.from!=null)arr=arr.filter(function(t){return t.todoTime>=f.from});" +
      "if(f.to!=null)arr=arr.filter(function(t){return t.todoTime<=f.to});" +
      "if(f.reminderDate)arr=arr.filter(function(t){var st=new Date(f.reminderDate+'T00:00:00').getTime();return t.reminderTime>=st&&t.reminderTime<st+86400000});" +
      "if(f.reminderFrom!=null)arr=arr.filter(function(t){return t.reminderTime>=f.reminderFrom});" +
      "if(f.reminderTo!=null)arr=arr.filter(function(t){return t.reminderTime<=f.reminderTo});" +
      "if(f.limit&&f.limit>0)arr=arr.slice(0,f.limit);" +
      // subtasks: 解析 standbyStr2 → [{content, done}]；保留原始 standbyStr2
      "var _sub=(function(s){if(!s)return[];var o=[],m,re=/- \\[(.)]([\\s\\S]*?)(?:\\[end]|$)/g;while((m=re.exec(s))!==null){o.push({done:(m[1]==='x'||m[1]==='X'),content:(m[2]||'').trim()});}return o;});" +
      "for(var _i=0;_i<arr.length;_i++){var _c=JSON.parse(JSON.stringify(arr[_i]));_c.subtasks=_sub(_c.standbyStr2);arr[_i]=_c;}" +
      "return JSON.parse(JSON.stringify(arr))" +
      "})()"
    );
  }
  // 今日所有任务：按本地时区"今天"过滤 todoTime/dayStart，避免无筛选拉全量(3500+)
  async todayTodos(filter) {
    filter = filter || {};
    var f = {};
    if (filter.categoryId != null) f.categoryId = parseInt(filter.categoryId);
    if (filter.includeDeleted) f.includeDeleted = true;
    if (filter.active) f.active = true;
    if (filter.limit != null) f.limit = parseInt(filter.limit) || 0;
    f.date = todayStr(); // 本地时区今天 YYYY-MM-DD
    return this.getTodos(f);
  }
  async getTodo(id) {
    if (id === undefined || id === null || id === '') return { __error__: 'id required' };
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "var id=" + JSON.stringify(String(id)) + ";" +
      "var nid=Number(id);var hasNum=!isNaN(nid);" +
      "var list=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "var _sub=(function(s){if(!s)return[];var o=[],m,re=/- \\[(.)]([\\s\\S]*?)(?:\\[end]|$)/g;while((m=re.exec(s))!==null){o.push({done:(m[1]==='x'||m[1]==='X'),content:(m[2]||'').trim()});}return o;});" +
      "for(var i=0;i<list.length;i++){" +
      "var t=list[i];" +
      "if(t.taskId===id||(hasNum&&Number(t.id)===nid)){var _c=JSON.parse(JSON.stringify(t));_c.subtasks=_sub(_c.standbyStr2);return{found:true,todo:_c};}" +
      "}" +
      "return{found:false};" +
      "})()"
    );
  }
  async createTodo(params) {
    params = params || {};
    var todoContent = params.todoContent || params.title || '';
    var categoryId = parseInt(params.categoryId) || 0;
    var dateParam = params.todoDate !== undefined && params.todoDate !== null && params.todoDate !== '' ? params.todoDate : params.date;
    var reminderParam = params.todoReminderTime !== undefined && params.todoReminderTime !== null && params.todoReminderTime !== '' ? params.todoReminderTime : params.reminderTime;
    var todoDate = dateParam !== undefined ? toPlanTs(dateParam) : 0;
    var todoReminderTime = reminderParam !== undefined ? toReminderTs(reminderParam, dateParam) : 0;
    var p = {
      categoryId: categoryId,
      todoContent: todoContent,
      todoDescription: params.todoDescription || params.content || '',
      todoDate: todoDate || 0,
      todoReminderTime: todoReminderTime || 0,
      todoDifficultyLevel: params.todoDifficultyLevel || params.difficulty || 0,
      repeatId: params.repeatId || null,
      todoSublist: params.todoSublist || params.sublist || null,
      todoImage: params.todoImage || null,
      fileList: params.fileList || null,
      addToTop: params.addToTop !== undefined ? !!params.addToTop : true,
    };
    var payload = JSON.stringify(p);
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "var p=" + payload + ";" +
      "var userId=s.state.auth&&s.state.auth.user?(s.state.auth.user.userId||s.state.auth.user.id):null;" +
      "if(userId)p.userId=userId;" +
      "var list0=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "var before={};for(var bi=0;bi<list0.length;bi++)before[list0[bi].taskId]=true;" +
      "try{" +
      "var r=s._actions['todo/addTodo'][0](p);" +
      "return Promise.resolve(r).then(function(v){" +
      "var list=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "var created=null;" +
      "if(v&&v.taskId){for(var j=0;j<list.length;j++)if(list[j].taskId===v.taskId){created=list[j];break;}}" +
      "if(!created){if(p.addToTop&&list[0]&&!before[list[0].taskId])created=list[0];else{for(var k=0;k<list.length;k++)if(!before[list[k].taskId]){created=list[k];break;}}}" +
      "var out={ok:true,params:p};" +
      "if(created){" +
      "out.taskId=created.taskId;out.id=created.id||null;" +
      "out.taskContent=created.taskContent||p.todoContent;" +
      "out.categoryId=created.standbyInt1!==undefined?created.standbyInt1:p.categoryId;" +
      "out.todoTime=created.todoTime||p.todoDate||0;" +
      "out.reminderTime=created.reminderTime||p.todoReminderTime||0;" +
      "}" +
      "return out;" +
      "},function(e){return{__error__:e.message}});" +
      "}catch(e){return{__error__:e.message}}" +
      "})()",
      true
    );
  }
  async updateTodo(id, patch) {
    if (id === undefined || id === null || id === '') return { __error__: 'id required' };
    patch = patch || {};
    // 友好字段 → store 字段映射
    var p = {};
    if (patch.complete !== undefined) p.complete = !!patch.complete;
    if (patch.title !== undefined) p.taskContent = patch.title;
    if (patch.content !== undefined) p.taskDescribe = patch.content;
    if (patch.categoryId !== undefined) p.standbyInt1 = parseInt(patch.categoryId) || 0;
    if (patch.difficulty !== undefined) p.snowAssess = parseInt(patch.difficulty) || 0;
    if (patch.date !== undefined) p.todoTime = toPlanTs(patch.date);
    if (patch.reminderTime !== undefined) p.reminderTime = toReminderTs(patch.reminderTime, patch.date);
    // 透传其余原始 store 字段（如 snowAdd、taskContent 等直接可写）
    for (var k in patch) {
      if (['complete', 'title', 'content', 'categoryId', 'difficulty', 'date', 'reminderTime'].indexOf(k) === -1 && !(k in p)) {
        p[k] = patch[k];
      }
    }
    var ps = JSON.stringify(p);
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "var id=" + JSON.stringify(String(id)) + ";" +
      "var nid=Number(id);var hasNum=!isNaN(nid);" +
      "var list=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "var todo=null;" +
      "for(var i=0;i<list.length;i++){" +
      "var t=list[i];" +
      "if(t.taskId===id||(hasNum&&Number(t.id)===nid)){todo=t;break;}" +
      "}" +
      "if(!todo)return{__error__:'todo not found for id='+id};" +
      "var p=" + ps + ";" +
      "try{" +
      "var payload={taskId:todo.taskId};for(var k in p)payload[k]=p[k];" +
      "s.commit('todo/updateTodo',payload);" +
      "return{ok:true,taskId:todo.taskId,id:todo.id||null,patch:payload};" +
      "}catch(e){return{__error__:e.message}}" +
      "})()",
      true
    );
  }
  async deleteTodo(id) {
    if (id === undefined || id === null || id === '') return { __error__: 'id required' };
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "var id=" + JSON.stringify(String(id)) + ";" +
      "var nid=Number(id);var hasNum=!isNaN(nid);" +
      "var list=s.state.todo&&s.state.todo.todoList?s.state.todo.todoList:[];" +
      "var todo=null;" +
      "for(var i=0;i<list.length;i++){" +
      "var t=list[i];" +
      "if(t.taskId===id||(hasNum&&Number(t.id)===nid)){todo=t;break;}" +
      "}" +
      "if(!todo)return{__error__:'todo not found for id='+id};" +
      "try{s.commit('todo/deleteTodo',todo);" +
      "return{ok:true,id:todo.id||null,taskId:todo.taskId,taskContent:todo.taskContent};" +
      "}catch(e){return{__error__:e.message}}" +
      "})()",
      true
    );
  }
  async syncNow() {
    return this._eval(
      "(function(){" +
      "var s=" + VUEX_EXPR + ";if(!s)return{__error__:'no store'};" +
      "try{" +
      "var syncAction=s._actions['todo/syncTodos'];" +
      "var refreshAction=s._actions['todo/refreshTodos'];" +
      "var fn=syncAction&&syncAction[0]?syncAction[0]:(refreshAction&&refreshAction[0]?refreshAction[0]:null);" +
      "if(!fn)return{__error__:'sync/refresh not found in store'};" +
      "var r=fn();" +
      "return Promise.resolve(r).then(function(v){return{ok:true,synced:true}}," +
      "function(e){return{__error__:e.message}});" +
      "}catch(e){return{__error__:e.message}}" +
      "})()",
      true
    );
  }
  async getDiagnostics() {
    return this._eval(
      "(function(){" +
      "var el=document.querySelector('#app')||document.querySelector('[data-v-]');" +
      "var r={vueVersion:null,storePath:null,storeModules:null};" +
      "if(!el){r.error='no app element';return r}" +
      "var s=null;" +
      "if(el.__vue_app__){" +
      "r.vueVersion=3;r.storePath='__vue_app__';" +
      "var gp=el.__vue_app__.config&&el.__vue_app__.config.globalProperties;" +
      "s=(gp&&gp.$store)||(el.__vue_app__._instance&&el.__vue_app__._instance.proxy.$store)||null;" +
      "}" +
      "if(el.__vue__){r.vueVersion=2;r.storePath='__vue__';s=el.__vue__.$store;}" +
      "if(!s){r.error='no store';return r}" +
      "r.storeModules=Object.keys(s.state||{});" +
      "if(s.state.todo&&s.state.todo.todoList&&s.state.todo.todoList.length)" +
      "  r.todoFields=Object.keys(s.state.todo.todoList[0]);" +
      "if(s.state.category&&s.state.category.list&&s.state.category.list.length)" +
      "  r.categoryFields=Object.keys(s.state.category.list[0]);" +
      "if(s._actions)r.actions=Object.keys(s._actions).filter(function(a){return a.indexOf('todo/')===0||a.indexOf('category/')===0});" +
      "if(s._mutations)r.mutations=Object.keys(s._mutations).filter(function(a){return a.indexOf('todo/')===0||a.indexOf('category/')===0});" +
      "return r" +
      "})()"
    );
  }
}
module.exports = TodoClient;

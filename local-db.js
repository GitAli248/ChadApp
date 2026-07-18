// ============================================================
// Supabase client wrapper — replaces the old mock/local-db
// Maintains window.sb API surface for app.js compatibility
// ============================================================

const { createClient } = supabase;
const _supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const _sessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);

// ====== Reactive callback registry ======
const _on = {
  message: null,
  conversation: null,
  request: null,
  onlineUsers: null,
  typing: null,
  authChange: null,
};

// ====== Channels ======
let _dbChannel = null;
let _presenceChannel = null;
let _typingChannel = null;
let _sessionRegistered = false;

// ====== Presence helpers ======
const _onlineUsers = new Set();

function registerSession(userId) {
  if (_sessionRegistered) return;
  _sessionRegistered = true;

  _presenceChannel = _supa.channel('online-users', {
    config: { presence: { key: userId } },
  });

  _presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const newUsers = new Set();
      _presenceChannel.presenceState();
      for (const uid of Object.keys(_presenceChannel.presenceState())) {
        newUsers.add(uid);
      }
      _onlineUsers.clear();
      for (const u of newUsers) _onlineUsers.add(u);
      window._onlineUsers = _onlineUsers;
      if (_on.onlineUsers) _on.onlineUsers(_onlineUsers);
    })
    .on('presence', { event: 'join' }, ({ key }) => {
      _onlineUsers.add(key);
      window._onlineUsers = _onlineUsers;
      if (_on.onlineUsers) _on.onlineUsers(_onlineUsers);
    })
    .on('presence', { event: 'leave' }, ({ key }) => {
      _onlineUsers.delete(key);
      window._onlineUsers = _onlineUsers;
      if (_on.onlineUsers) _on.onlineUsers(_onlineUsers);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await _presenceChannel.track({ online_at: new Date().toISOString() });
      }
    });
}

function unregisterSession() {
  if (_presenceChannel) {
    _supa.removeChannel(_presenceChannel);
    _presenceChannel = null;
  }
  _sessionRegistered = false;
}

// ====== DB change subscriptions ======
function subscribeToChanges() {
  if (_dbChannel) return;

  _dbChannel = _supa.channel('db-changes');

  _dbChannel
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages' },
      (payload) => {
        if (_on.message) _on.message(payload);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversations' },
      (payload) => {
        if (_on.conversation) _on.conversation(payload);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'chat_requests' },
      (payload) => {
        if (_on.request) _on.request(payload);
      }
    )
    .subscribe();
}

function unsubscribeFromChanges() {
  if (_dbChannel) {
    _supa.removeChannel(_dbChannel);
    _dbChannel = null;
  }
}

// ====== Auth ======
_supa.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN') {
    subscribeToChanges();
    if (session?.user) registerSession(session.user.id);
  } else if (event === 'SIGNED_OUT') {
    unsubscribeFromChanges();
    unregisterSession();
  }
  if (_on.authChange) _on.authChange(event, session);
});

// ====== Chainable query builder ======
function genId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function buildQuery(tableName) {
  const filters = [];
  let singleResult = false;
  let orderSpec = null;
  let selectCols = '*';
  let isSelectAction = true;
  let pendingData = null;
  let orFilter = null;

  const api = {
    select(cols) {
      selectCols = cols || '*';
      // Don't override insert/update/delete actions
      return api;
    },
    eq(col, val) {
      filters.push({ col, val });
      return api;
    },
    or(filter) {
      orFilter = filter;
      return api;
    },
    single() {
      singleResult = true;
      return api;
    },
    order(col, dir) {
      orderSpec = { col, ascending: dir?.ascending !== false };
      return api;
    },
    insert(data) {
      isSelectAction = false;
      pendingData = { type: 'insert', data };
      return api;
    },
    update(data) {
      isSelectAction = false;
      pendingData = { type: 'update', data };
      return api;
    },
    delete() {
      isSelectAction = false;
      pendingData = { type: 'delete', data: null };
      return api;
    },
    async then(resolve, reject) {
      try {
        let result;
        if (pendingData?.type === 'insert') {
          let q = _supa.from(tableName).insert(pendingData.data).select();
          result = await q;
          if (result?.error) throw result.error;
          // .single() equivalent: if we expect one row, unwrap the array
          if (singleResult && Array.isArray(result?.data) && result.data.length > 0) {
            result.data = result.data[0];
          } else if (singleResult) {
            result.data = null;
          }
        } else if (pendingData?.type === 'update') {
          let query = _supa.from(tableName).update(pendingData.data);
          for (const f of filters) query = query.eq(f.col, f.val);
          result = await query;
        } else if (pendingData?.type === 'delete') {
          let query = _supa.from(tableName).delete();
          for (const f of filters) query = query.eq(f.col, f.val);
          result = await query;
        } else {
          let query = _supa.from(tableName).select(selectCols);
          for (const f of filters) query = query.eq(f.col, f.val);
          if (orFilter) query = query.or(orFilter);
          if (orderSpec) query = query.order(orderSpec.col, { ascending: orderSpec.ascending });
          result = await query;
          // Handle .single() manually — NEVER call Supabase's .single() (it throws "cannot coerce")
          if (singleResult && Array.isArray(result?.data) && result.data.length > 0) {
            result.data = result.data[0];
          } else if (singleResult) {
            result.data = null;
          }
        }
        if (result?.error) throw result.error;
        resolve(result);
      } catch (e) { reject(e); }
    },
  };
  return api;
}

// ====== window.sb — API surface for app.js ======
window.sb = {
  // Auth
  auth: {
    async signUp({ email, password }) {
      return _supa.auth.signUp({ email, password });
    },
    async signInWithPassword({ email, password }) {
      return _supa.auth.signInWithPassword({ email, password });
    },
    async signOut() {
      return _supa.auth.signOut();
    },
    async getSession() {
      return _supa.auth.getSession();
    },
    onAuthStateChange(cb) {
      _on.authChange = cb;
    },
    async updateUser(updates) {
      return _supa.auth.updateUser(updates);
    },
    async resetPasswordForEmail(email) {
      return _supa.auth.resetPasswordForEmail(email);
    },
  },

  // Database — chainable query builder (same API as old mock)
  from(tableName) {
    return buildQuery(tableName);
  },

  // RPC for custom functions
  async rpc(fn, params) {
    return _supa.rpc(fn, params);
  },

  // Raw client for advanced use
  get client() {
    return _supa;
  },

  // ====== Realtime event registration ======
  /**
   * Register callbacks for realtime events.
   * app.js calls these instead of polling localStorage.
   */
  onMessage(cb) {
    _on.message = cb;
  },
  onConversation(cb) {
    _on.conversation = cb;
  },
  onRequest(cb) {
    _on.request = cb;
  },
  onOnlineUsers(cb) {
    _on.onlineUsers = cb;
  },
  onTyping(cb) {
    _on.typing = cb;
  },

  // ====== Typing indicator (broadcast) ======
  async startTyping(conversationId, userId) {
    if (!_typingChannel) {
      _typingChannel = _supa.channel('typing');
      _typingChannel
        .on('broadcast', { event: 'typing' }, (payload) => {
          if (_on.typing) _on.typing(payload);
        })
        .subscribe();
    }
    await _typingChannel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { conversationId, userId, typing: true },
    });
  },

  async stopTyping(conversationId, userId) {
    if (_typingChannel) {
      await _typingChannel.send({
        type: 'broadcast',
        event: 'typing',
        payload: { conversationId, userId, typing: false },
      });
    }
  },

  // ====== Online users ======
  getOnlineUsers() {
    return _onlineUsers;
  },

  // ====== Legacy stubs (app.js may call these) ======
  removeChannel() {},
  channel() {
    return { on() { return this; }, subscribe() {} };
  },

  // ====== Session helpers ======
  sessions: {
    async register(userId) {
      registerSession(userId);
    },
    async unregister(userId) {
      unregisterSession();
    },
    async heartbeat(userId) {
      // No-op — Supabase presence handles this automatically
    },
    async fetchOnline() {
      return Array.from(_onlineUsers);
    },
  },
};

// ====== Auto-subscribe if already signed in ======
_supa.auth.getSession().then(({ data: { session } }) => {
  if (session?.user) {
    subscribeToChanges();
    registerSession(session.user.id);
  }
});

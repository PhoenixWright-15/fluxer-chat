/* ============================================================
   Fluxer Chat — main.js
   Production-quality Discord-like chat client
   ============================================================ */

// --------------- Configuration ---------------
const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:10000').replace(/\/+$/, '');
const WS_URL  = import.meta.env.VITE_WS_URL  || 'ws://localhost:10000/ws';

const ROOMS = ['general', 'random', 'tech'];
const ROOM_TOPICS = {
  general: 'Welcome to #general — say hi!',
  random:  'Off-topic banter and fun',
  tech:    'Programming, tech news, and hacking',
};

// Deterministic avatar colors seeded by username
const AVATAR_COLORS = [
  '#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245',
  '#F47B67', '#E78B38', '#45DDC0', '#9B59B6', '#3498DB',
  '#1ABC9C', '#E74C3C', '#E91E63', '#2ECC71', '#00BCD4',
];

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarLetter(name) {
  return (name || '?')[0].toUpperCase();
}

// --------------- State ---------------
let username   = localStorage.getItem('fluxer_username') || '';
let currentRoom = 'general';
/** @type {WebSocket | null} */
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30_000;
let pingInterval = null;

/** Per-room unread counts (only for rooms not currently viewed) */
const unreadCounts = { general: 0, random: 0, tech: 0 };

/** Set of usernames we've seen, for the member list */
const knownUsers = new Set();

// --------------- DOM refs ---------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loginScreen      = $('#login-screen');
const chatScreen       = $('#chat-screen');
const loginForm        = $('#login-form');
const usernameInput    = $('#username-input');
const chatRoomName     = $('#chat-room-name');
const chatTopic        = $('#chat-topic');
const messagesContainer = $('#messages-container');
const messagesList     = $('#messages-list');
const messageForm      = $('#message-form');
const messageInput     = $('#message-input');
const connectionStatus = $('#connection-status');
const statusText       = connectionStatus.querySelector('.status-text');
const userAvatar       = $('#user-avatar');
const userDisplayName  = $('#user-display-name');
const logoutBtn        = $('#logout-btn');
const membersToggle    = $('#members-toggle');
const membersSidebar   = $('#members-sidebar');
const membersList      = $('#members-list');
const onlineCount      = $('#online-count');
const welcomeRoomName  = $('#welcome-room-name');
const welcomeRoomName2 = $('#welcome-room-name-2');
const welcomeMessage   = $('#welcome-message');

// --------------- Helpers ---------------

/** Format a timestamp for display */
function formatTimestamp(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d)) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: 'numeric' })} ${time}`;
}

/** Escape HTML to prevent XSS */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Scroll chat to bottom */
function scrollToBottom(force = false) {
  const el = messagesContainer;
  // Only auto-scroll if user is near the bottom (within 150px) or forced
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  if (force || isNearBottom) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

// --------------- Connection Status ---------------

function setConnectionStatus(state) {
  connectionStatus.className = `connection-status ${state}`;
  const labels = {
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  };
  statusText.textContent = labels[state] || 'Connecting…';
}

// --------------- Members Sidebar ---------------

function addKnownUser(name) {
  if (!name) return;
  knownUsers.add(name);
  renderMembers();
}

function renderMembers() {
  const sorted = [...knownUsers].sort((a, b) => a.localeCompare(b));
  onlineCount.textContent = sorted.length;
  membersList.innerHTML = sorted
    .map(
      (name) => `
    <div class="member-item">
      <div class="member-avatar" style="background:${avatarColor(name)}">${avatarLetter(name)}</div>
      <span class="member-name">${escapeHtml(name)}</span>
    </div>`
    )
    .join('');
}

// --------------- Unread Badges ---------------

function incrementUnread(room) {
  if (room === currentRoom) return;
  unreadCounts[room] = (unreadCounts[room] || 0) + 1;
  updateBadge(room);
}

function clearUnread(room) {
  unreadCounts[room] = 0;
  updateBadge(room);
}

function updateBadge(room) {
  const btn = $(`.channel-btn[data-room="${room}"]`);
  if (!btn) return;
  const badge = btn.querySelector('.unread-badge');
  const count = unreadCounts[room] || 0;
  if (count > 0) {
    badge.style.display = '';
    badge.textContent = count > 99 ? '99+' : count;
    btn.classList.add('has-unread');
  } else {
    badge.style.display = 'none';
    badge.textContent = '';
    btn.classList.remove('has-unread');
  }
}

// --------------- Message Rendering ---------------

/** Track previous message for grouping */
let lastRenderedUsername = null;
let lastRenderedTime = 0;

function resetMessageGrouping() {
  lastRenderedUsername = null;
  lastRenderedTime = 0;
}

function renderMessage(msg, prepend = false) {
  const { username: name, content, created_at, id } = msg;
  if (name) addKnownUser(name);

  const ts = created_at ? new Date(created_at) : new Date();
  const timeDiff = ts - lastRenderedTime;
  const isGrouped = !prepend && name === lastRenderedUsername && timeDiff < 7 * 60 * 1000; // 7 min

  const el = document.createElement('div');
  el.className = `message${isGrouped ? '' : ' has-avatar'}`;
  if (id) el.dataset.id = id;

  if (isGrouped) {
    el.innerHTML = `<div class="message-content">${escapeHtml(content)}</div>`;
  } else {
    el.innerHTML = `
      <div class="message-avatar" style="background:${avatarColor(name)}">${avatarLetter(name)}</div>
      <div class="message-header">
        <span class="message-username" style="color:${avatarColor(name)}">${escapeHtml(name)}</span>
        <span class="message-timestamp">${formatTimestamp(ts)}</span>
      </div>
      <div class="message-content">${escapeHtml(content)}</div>`;
  }

  if (!prepend) {
    // Check if welcome message should be before this
    messagesList.appendChild(el);
    lastRenderedUsername = name;
    lastRenderedTime = ts;
  } else {
    // For history prepend: insert after the welcome message
    const firstMsg = messagesList.querySelector('.message');
    if (firstMsg) {
      messagesList.insertBefore(el, firstMsg);
    } else {
      messagesList.appendChild(el);
    }
  }

  return el;
}

function clearMessages() {
  // Keep welcome message, remove everything else
  const msgs = messagesList.querySelectorAll('.message');
  msgs.forEach((m) => m.remove());
  resetMessageGrouping();
}

function setWelcomeRoom(room) {
  welcomeRoomName.textContent = room;
  welcomeRoomName2.textContent = room;
}

// --------------- Room Switching ---------------

function switchRoom(room) {
  if (!ROOMS.includes(room)) return;
  currentRoom = room;
  clearUnread(room);

  // UI updates
  $$('.channel-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.room === room);
  });
  chatRoomName.textContent = room;
  chatTopic.textContent = ROOM_TOPICS[room] || '';
  messageInput.placeholder = `Message #${room}`;
  setWelcomeRoom(room);
  clearMessages();

  // Tell server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'join', room }));
  }

  // Also fetch history via REST as fallback
  fetchHistory(room);
  messageInput.focus();
}

// --------------- REST API ---------------

async function fetchHistory(room) {
  try {
    const res = await fetch(`${API_URL}/api/messages?room=${encodeURIComponent(room)}&limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    const messages = Array.isArray(data) ? data : data.messages || [];
    if (messages.length === 0) return;

    // Clear and re-render (in chronological order)
    clearMessages();
    // Messages from REST are newest-first typically; sort by created_at ascending
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );
    for (const msg of sorted) {
      renderMessage(msg);
    }
    scrollToBottom(true);
  } catch (err) {
    console.warn('[Fluxer] Failed to fetch history:', err);
  }
}

// --------------- WebSocket ---------------

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  setConnectionStatus('reconnecting');

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[Fluxer] WS construction error:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Fluxer] WebSocket connected');
    reconnectAttempts = 0;
    setConnectionStatus('connected');

    // Join current room
    ws.send(JSON.stringify({ type: 'join', room: currentRoom }));

    // Start keepalive
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25_000);
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (data.type) {
      case 'message':
        handleIncomingMessage(data);
        break;

      case 'history':
        handleHistory(data);
        break;

      case 'pong':
        // keepalive acknowledged
        break;

      default:
        console.log('[Fluxer] Unknown WS message type:', data.type);
    }
  };

  ws.onclose = (event) => {
    console.log('[Fluxer] WebSocket closed', event.code, event.reason);
    clearInterval(pingInterval);
    setConnectionStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[Fluxer] WebSocket error:', err);
    // onclose will fire after this
  };
}

function handleIncomingMessage(data) {
  // If message is for the current room or room not specified, render it
  const msgRoom = data.room || currentRoom;
  if (msgRoom === currentRoom) {
    renderMessage(data);
    scrollToBottom();
  } else {
    // Unread for another room
    incrementUnread(msgRoom);
  }
  addKnownUser(data.username);
}

function handleHistory(data) {
  const messages = data.messages || [];
  if (messages.length === 0) return;
  clearMessages();
  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
  for (const msg of sorted) {
    renderMessage(msg);
  }
  scrollToBottom(true);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[Fluxer] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setConnectionStatus('reconnecting');
  reconnectTimer = setTimeout(connectWebSocket, delay);
}

function disconnectWebSocket() {
  clearTimeout(reconnectTimer);
  clearInterval(pingInterval);
  reconnectAttempts = 0;
  if (ws) {
    ws.onclose = null; // Prevent auto-reconnect
    ws.close();
    ws = null;
  }
  setConnectionStatus('disconnected');
}

// --------------- Sending Messages ---------------

function sendMessage(content) {
  if (!content.trim()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[Fluxer] Cannot send — not connected');
    return;
  }

  ws.send(
    JSON.stringify({
      type: 'message',
      username,
      content: content.trim(),
      room: currentRoom,
    })
  );
}

// --------------- Login / Logout ---------------

function showLogin() {
  loginScreen.classList.add('active');
  chatScreen.classList.remove('active');
  usernameInput.value = username || '';
  setTimeout(() => usernameInput.focus(), 100);
}

function showChat() {
  loginScreen.classList.remove('active');
  chatScreen.classList.add('active');

  // Set user panel
  userAvatar.style.background = avatarColor(username);
  userAvatar.textContent = avatarLetter(username);
  userDisplayName.textContent = username;

  addKnownUser(username);

  // Connect and load
  switchRoom(currentRoom);
  connectWebSocket();
  messageInput.focus();
}

function logout() {
  disconnectWebSocket();
  localStorage.removeItem('fluxer_username');
  username = '';
  knownUsers.clear();
  renderMembers();
  clearMessages();
  resetMessageGrouping();
  Object.keys(unreadCounts).forEach((r) => {
    unreadCounts[r] = 0;
    updateBadge(r);
  });
  showLogin();
}

// --------------- Event Listeners ---------------

// Login
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  if (!name) return;
  username = name;
  localStorage.setItem('fluxer_username', username);
  showChat();
});

// Send message
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const content = messageInput.value;
  if (!content.trim()) return;
  sendMessage(content);
  messageInput.value = '';
  messageInput.focus();
});

// Enter key (no shift) sends
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    messageForm.dispatchEvent(new Event('submit'));
  }
});

// Room switching
$$('.channel-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const room = btn.dataset.room;
    if (room && room !== currentRoom) {
      switchRoom(room);
    }
  });
});

// Category toggle
$$('.category-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', !expanded);
    const channels = btn.nextElementSibling;
    if (channels) {
      channels.style.display = expanded ? 'none' : '';
    }
  });
});

// Members toggle
membersToggle.addEventListener('click', () => {
  membersToggle.classList.toggle('active');
  membersSidebar.classList.toggle('hidden');
});

// Logout
logoutBtn.addEventListener('click', logout);

// --------------- Init ---------------
(function init() {
  // Auto-login if username is stored
  if (username) {
    showChat();
  } else {
    showLogin();
  }
})();

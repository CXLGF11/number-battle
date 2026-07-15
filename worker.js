/**
 * 数字猜猜猜 - Cloudflare Worker
 * Durable Objects 实现 WebSocket 房间
 */

export { GameRoom };

class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.players = [];
    this.phase = 'lobby';
    this.roomId = '';
    this.diceRolls = [0, 0];
    this.firstPlayer = -1;
    this.currentTurn = -1;
    this.round = 1;
    this.guessHistory = [[], []];
    this.restartVotes = [false, false];
    this.readyToStart = [false, false];
    this.heartbeatInterval = null;
    this.ctx = null;
  }

  async fetch(request, env, ctx) {
      if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      const url = new URL(request.url);
      const roomId = url.searchParams.get('roomId');
      this.handleSession(server, roomId);
      // 每25秒发一次心跳，防止连接被静默断开
      if (!this.heartbeatInterval) {
        this.heartbeatInterval = setInterval(() => {
          this.broadcast({ type: 'ping' });
        }, 25000);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('ok');
  }

  handleSession(ws, roomId) {
    let seat = -1;
    const resetTimer = () => setTimeout(() => { try { ws.close(); } catch {} }, 600000);
    let timer = resetTimer();

    ws.addEventListener('message', e => {
      clearTimeout(timer);
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'pong') { clearTimeout(timer); timer = resetTimer(); return; }

      if (msg.type === 'create_room') {
        seat = 0;
        this.roomId = roomId || this.roomId || genId();
        this.players = [{ name: msg.name || '玩家1', seatIndex: 0, secret: '', confirmed: false }];
        this.sessions = [{ ws, seatIndex: 0 }];
        this.phase = 'lobby';
        this.send(ws, { type: 'room_created', roomId: this.roomId, seatIndex: 0, roomInfo: this.info() });
      }
      else if (msg.type === 'join_room') {
        if (this.players.length >= 2) return this.send(ws, { type: 'error', msg: '房间已满' });
        if (this.phase !== 'lobby') return this.send(ws, { type: 'error', msg: '游戏已经开始' });
        seat = 1;
        this.players.push({ name: msg.name || '玩家2', seatIndex: 1, secret: '', confirmed: false });
        this.sessions.push({ ws, seatIndex: 1 });
        this.phase = 'setup';
        this.broadcastAll({ type: 'room_joined', roomInfo: this.info() });
      }
      else if (msg.type === 'set_secret' && seat >= 0) {
        const p = this.players[seat];
        if (!p || p.confirmed) return;
        p.secret = msg.secret; p.confirmed = true;
        this.broadcastAll({ type: 'player_confirmed', seatIndex: seat, allConfirmed: this.players.every(x => x.confirmed) });
        if (this.players.every(x => x.confirmed)) { this.phase = 'dice'; this.broadcastAll({ type: 'phase_dice' }); }
      }
      else if (msg.type === 'roll_dice') {
        if (this.phase !== 'dice') return;
        if (seat < 0) return;
        const r = Math.ceil(Math.random() * 6);
        this.diceRolls[seat] = r;
        this.broadcastAll({ type: 'dice_rolled', seatIndex: seat, value: r });
        // 双方都摇完了，比较大小
        if (this.diceRolls[0] > 0 && this.diceRolls[1] > 0) {
          const r1 = this.diceRolls[0], r2 = this.diceRolls[1];
          if (r1 === r2) {
            // 平局，重置骰子让双方重新摇
            this.diceRolls = [0, 0];
            this.readyToStart = [false, false];
            this.broadcastAll({ type: 'dice_result', r1, r2, tie: true });
          } else {
            this.firstPlayer = r1 > r2 ? 0 : 1;
            this.broadcastAll({ type: 'dice_result', r1, r2, tie: false, firstPlayer: this.firstPlayer });
          }
        }
      }
      else if (msg.type === 'start_game') {
        if (this.phase !== 'dice' || this.firstPlayer === -1) return;
        this.readyToStart[seat] = true;
        this.broadcastAll({ type: 'player_ready', seatIndex: seat });
        // 双方都点了开始，才正式开始游戏
        if (this.readyToStart[0] && this.readyToStart[1]) {
          this.phase = 'game'; this.currentTurn = this.firstPlayer;
          this.broadcastAll({ type: 'game_started', firstPlayer: this.firstPlayer, currentTurn: this.currentTurn, round: this.round });
        }
      }
      else if (msg.type === 'submit_guess' && seat >= 0) {
        if (this.phase !== 'game') return;
        if (seat !== this.currentTurn) return this.send(ws, { type: 'error', msg: '还没轮到你猜' });
        const guess = msg.guess, target = this.players[1 - seat].secret;
        const hits = countHits(guess, target), exact = countExact(guess, target);
        this.guessHistory[seat].push({ guess, hits, exact, round: this.round });
        this.broadcastAll({ type: 'guess_result', seatIndex: seat, guess, hits, exact, round: this.round });
        if (guess === target) {
          this.phase = 'ended';
          this.broadcastAll({ type: 'game_over', winner: seat, secrets: this.players.map(p => p.secret), guessCounts: [this.guessHistory[0].length, this.guessHistory[1].length], firstPlayer: this.firstPlayer });
          return;
        }
        if (seat !== this.firstPlayer) this.round++;
        this.currentTurn = 1 - seat;
        this.broadcastAll({ type: 'turn_change', currentTurn: this.currentTurn, round: this.round });
      }
      else if (msg.type === 'restart_request') {
        this.restartVotes[seat] = true;
        const otherSeat = 1 - seat;
        this.broadcastAll({ type: 'restart_requested', from: seat });
        if (this.restartVotes[otherSeat]) {
          this.restartVotes = [false, false];
          this.phase = 'setup'; this.diceRolls = [0, 0]; this.firstPlayer = -1; this.currentTurn = -1; this.round = 1; this.guessHistory = [[], []]; this.readyToStart = [false, false];
          this.players.forEach(p => { p.secret = ''; p.confirmed = false; });
          this.broadcastAll({ type: 'restarted', roomInfo: this.info() });
        }
      }
      else if (msg.type === 'restart_cancel') {
        this.restartVotes[seat] = false;
        this.broadcastAll({ type: 'restart_cancelled', from: seat });
      }
      else if (msg.type === 'restart_reject') {
        this.restartVotes = [false, false];
        this.broadcastAll({ type: 'restart_rejected', from: seat });
        // 拒绝后双方退出房间
        this.phase = 'idle';
        this.players = [];
        setTimeout(() => this.cleanup(), 1000);
      }
      timer = resetTimer();
    });

    ws.addEventListener('close', () => {
      clearTimeout(timer);
      this.sessions = this.sessions.filter(s => s.ws !== ws);
      if (this.sessions.length === 0 && this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.sessions.length > 0) this.broadcast({ type: 'opponent_left', seatIndex: seat }, ws);
    });
    ws.addEventListener('error', () => {});
  }

  send(ws, data) { try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch {} }
  broadcast(data, exclude) { const r = JSON.stringify(data); this.sessions.forEach(s => { try { if (s.ws.readyState === 1 && s.ws !== exclude) s.ws.send(r); } catch {} }); }
  broadcastAll(data) { this.broadcast(data); }
  cleanup() { this.sessions.forEach(s => { try { s.ws.close(); } catch {} }); this.sessions = []; this.players = []; this.phase = 'idle'; }
  info() { return { id: this.roomId, phase: this.phase, players: this.players.map(p => ({ name: p.name, seatIndex: p.seatIndex, confirmed: p.confirmed })) }; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML_CONTENT, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify({
        name: "数字猜猜猜 - 在线对战",
        short_name: "数字猜猜猜",
        description: "双人在线猜数字对战游戏",
        start_url: "/",
        display: "standalone",
        background_color: "#0a0a1a",
        theme_color: "#0a0a1a",
        orientation: "portrait",
        icons: [{ src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect width='192' height='192' rx='32' fill='%230a0a1a'/%3E%3Ctext x='96' y='110' text-anchor='middle' font-size='72'%3E🎲%3C/text%3E%3Ctext x='96' y='160' text-anchor='middle' font-size='28' fill='%23ffb800' font-weight='bold'%3E猜猜猜%3C/text%3E%3C/svg%3E", sizes: "192x192", type: "image/svg+xml" }]
      }), { headers: { 'content-type': 'application/json' } });
    }

    let doId;
    if (url.pathname === '/ws/create') {
      const code = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const roomId = Array.from(crypto.getRandomValues(new Uint8Array(4)), x => code[x % code.length]).join('');
      doId = env.ROOM.idFromName('room-' + roomId);
      const newUrl = new URL(request.url);
      newUrl.searchParams.set('roomId', roomId);
      const newReq = new Request(newUrl, request);
      return env.ROOM.get(doId).fetch(newReq);
    } else if (url.pathname === '/ws/join') {
      const room = url.searchParams.get('room');
      if (!room) return new Response('Missing room', { status: 400 });
      doId = env.ROOM.idFromName('room-' + room);
    } else return new Response('Not Found', { status: 404 });

    return env.ROOM.get(doId).fetch(request);
  }
};

function genId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(4); crypto.getRandomValues(a);
  return Array.from(a, x => c[x % c.length]).join('');
}
function countHits(g, s) { const sc = {}, gc = {}; for (const d of s) sc[d] = (sc[d] || 0) + 1; for (const d of g) gc[d] = (gc[d] || 0) + 1; let n = 0; for (const d in gc) if (sc[d]) n += Math.min(gc[d], sc[d]); return n; }
function countExact(g, s) { let n = 0; for (let i = 0; i < 4; i++) if (g[i] === s[i]) n++; return n; }

// 内嵌前端 HTML
const HTML_CONTENT = `PLACEHOLDER_HTML`;

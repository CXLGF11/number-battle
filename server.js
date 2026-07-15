/**
 * 数字猜猜猜 - 联机服务器
 * WebSocket + Express，支持多房间并发对战
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// 健康检查端点（用于监控）
app.get('/health', (req, res) => res.json({ ok: true }));

// 房间管理
const rooms = new Map(); // roomId -> RoomState

function genRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F2C1"
}

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data, excludeWs = null) {
  room.players.forEach(p => {
    if (p.ws !== excludeWs) send(p.ws, data);
  });
}

function broadcastAll(room, data) {
  room.players.forEach(p => send(p.ws, data));
}

/**
 * RoomState shape:
 * {
 *   id, phase, players: [{ws, name, secret, confirmed, seatIndex}],
 *   diceRolls: [0,0], firstPlayer: -1, currentTurn: -1,
 *   round: 1, guessHistory: [[],[]]
 * }
 */
function createRoom(id) {
  return {
    id,
    phase: 'lobby',   // lobby | setup | dice | game | ended
    players: [],
    diceRolls: [0, 0],
    firstPlayer: -1,
    currentTurn: -1,
    round: 1,
    guessHistory: [[], []],
  };
}

function getRoomInfo(room) {
  return {
    id: room.id,
    phase: room.phase,
    players: room.players.map(p => ({
      name: p.name,
      seatIndex: p.seatIndex,
      confirmed: p.confirmed,
    })),
  };
}

// ===== WebSocket 消息处理 =====
wss.on('connection', (ws) => {
  ws.playerInfo = null; // {roomId, seatIndex}

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    // ---- 创建房间 ----
    if (type === 'create_room') {
      const roomId = genRoomId();
      const room = createRoom(roomId);
      rooms.set(roomId, room);

      const player = { ws, name: msg.name || '玩家1', seatIndex: 0, secret: '', confirmed: false };
      room.players.push(player);
      ws.playerInfo = { roomId, seatIndex: 0 };

      send(ws, { type: 'room_created', roomId, seatIndex: 0, roomInfo: getRoomInfo(room) });
      return;
    }

    // ---- 加入房间 ----
    if (type === 'join_room') {
      const room = rooms.get(msg.roomId);
      if (!room) { send(ws, { type: 'error', msg: '房间不存在或已关闭' }); return; }
      if (room.players.length >= 2) { send(ws, { type: 'error', msg: '房间已满' }); return; }
      if (room.phase !== 'lobby') { send(ws, { type: 'error', msg: '游戏已经开始，无法加入' }); return; }

      const player = { ws, name: msg.name || '玩家2', seatIndex: 1, secret: '', confirmed: false };
      room.players.push(player);
      ws.playerInfo = { roomId: msg.roomId, seatIndex: 1 };

      // 告知双方
      room.phase = 'setup';
      broadcastAll(room, { type: 'room_joined', roomInfo: getRoomInfo(room) });
      return;
    }

    // 以下消息需要已在房间
    if (!ws.playerInfo) { send(ws, { type: 'error', msg: '未加入房间' }); return; }
    const { roomId, seatIndex } = ws.playerInfo;
    const room = rooms.get(roomId);
    if (!room) return;

    // ---- 提交秘密数字 ----
    if (type === 'set_secret') {
      const p = room.players[seatIndex];
      if (p.confirmed) return;
      p.secret = msg.secret;
      p.confirmed = true;

      broadcastAll(room, {
        type: 'player_confirmed',
        seatIndex,
        allConfirmed: room.players.length === 2 && room.players.every(p => p.confirmed),
      });

      if (room.players.length === 2 && room.players.every(p => p.confirmed)) {
        room.phase = 'dice';
        broadcastAll(room, { type: 'phase_dice' });
      }
      return;
    }

    // ---- 摇骰子 ----
    if (type === 'roll_dice') {
      if (room.phase !== 'dice') return;
      // 只要有人触发就服务端摇
      const r1 = Math.ceil(Math.random() * 6);
      const r2 = Math.ceil(Math.random() * 6);
      room.diceRolls = [r1, r2];

      if (r1 === r2) {
        broadcastAll(room, { type: 'dice_result', r1, r2, tie: true });
      } else {
        room.firstPlayer = r1 > r2 ? 0 : 1;
        broadcastAll(room, { type: 'dice_result', r1, r2, tie: false, firstPlayer: room.firstPlayer });
      }
      return;
    }

    // ---- 开始游戏 ----
    if (type === 'start_game') {
      if (room.phase !== 'dice' || room.firstPlayer === -1) return;
      room.phase = 'game';
      room.currentTurn = room.firstPlayer;
      broadcastAll(room, {
        type: 'game_started',
        firstPlayer: room.firstPlayer,
        currentTurn: room.currentTurn,
        round: room.round,
      });
      return;
    }

    // ---- 提交猜测 ----
    if (type === 'submit_guess') {
      if (room.phase !== 'game') return;
      if (seatIndex !== room.currentTurn) {
        send(ws, { type: 'error', msg: '还没轮到你猜' });
        return;
      }

      const guess = msg.guess;
      const target = room.players[1 - seatIndex].secret;

      const hits = countHits(guess, target);
      const exact = countExact(guess, target);

      const entry = { guess, hits, exact, round: room.round };
      room.guessHistory[seatIndex].push(entry);

      broadcastAll(room, {
        type: 'guess_result',
        seatIndex,
        guess,
        hits,
        exact,
        round: room.round,
      });

      // 胜利判断
      if (guess === target) {
        room.phase = 'ended';
        broadcastAll(room, {
          type: 'game_over',
          winner: seatIndex,
          secrets: room.players.map(p => p.secret),
          guessCounts: [room.guessHistory[0].length, room.guessHistory[1].length],
          firstPlayer: room.firstPlayer,
        });
        return;
      }

      // 换手
      if (seatIndex !== room.firstPlayer) room.round++;
      room.currentTurn = 1 - seatIndex;
      broadcastAll(room, {
        type: 'turn_change',
        currentTurn: room.currentTurn,
        round: room.round,
      });
      return;
    }

    // ---- 重新开始 ----
    if (type === 'restart') {
      room.phase = 'setup';
      room.diceRolls = [0, 0];
      room.firstPlayer = -1;
      room.currentTurn = -1;
      room.round = 1;
      room.guessHistory = [[], []];
      room.players.forEach(p => { p.secret = ''; p.confirmed = false; });
      broadcastAll(room, { type: 'restarted', roomInfo: getRoomInfo(room) });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.playerInfo) return;
    const { roomId, seatIndex } = ws.playerInfo;
    const room = rooms.get(roomId);
    if (!room) return;
    broadcast(room, { type: 'opponent_left', seatIndex }, ws);
    // 清理房间（等30秒后删除，给重连机会）
    setTimeout(() => {
      const r = rooms.get(roomId);
      if (r) {
        const alive = r.players.filter(p => p.ws.readyState === 1);
        if (alive.length === 0) rooms.delete(roomId);
      }
    }, 30000);
  });
});

// 工具函数
function countHits(guess, secret) {
  const sCount = {}, gCount = {};
  for (const d of secret) sCount[d] = (sCount[d] || 0) + 1;
  for (const d of guess) gCount[d] = (gCount[d] || 0) + 1;
  let count = 0;
  for (const d in gCount) {
    if (sCount[d]) count += Math.min(gCount[d], sCount[d]);
  }
  return count;
}

function countExact(guess, secret) {
  let count = 0;
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) count++;
  return count;
}

const PORT = process.env.PORT || 7788;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎲 数字猜猜猜联机服务器已启动: http://localhost:${PORT}`);
  console.log(`   本机访问: http://localhost:${PORT}`);
});

// bridge.js
require('dotenv').config();

const { spawn } = require('child_process');
const readline = require('readline');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// logging setup
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

function getLogFile() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOG_DIR, `${dateStr}.log`);
}

function writeToLogFile(args) {
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0]; // HH:mm:ss
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    const logLine = `[${timestamp}] ${message}\n`;
    
    try {
        fs.appendFileSync(getLogFile(), logLine);
    } catch (err) {
        process.stderr.write(`无法写入日志文件: ${err.message}\n`);
    }
}

// override console.log and console.error
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    originalLog(...args);
    writeToLogFile(args);
};

console.error = (...args) => {
    originalError(...args);
    writeToLogFile(args);
};

// configs

const CONFIG = {
	WS_URL: process.env.WS_URL,
	LOG_FILE: process.env.LOG_FILE,
	COOKIE: process.env.COOKIE 
};

if (!CONFIG.WS_URL || !CONFIG.LOG_FILE || !CONFIG.COOKIE) {
    console.error("[BRIDGE] ERROR: 请配置 .env 文件");
    process.exit(1);
}

console.log(`[BRIDGE] 正在启动...`);
console.log(`[BRIDGE] 监控日志: ${CONFIG.LOG_FILE}`);
console.log(`[BRIDGE] 目标地址: ${CONFIG.WS_URL}`);

let ws;
let msgQueue = [];
let idleTimer = null;

// WebSocket
function connect() {
    // if already connected or is connecting
    if ( ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

	ws = new WebSocket(CONFIG.WS_URL, {
		headers: {
			'Cookie': CONFIG.COOKIE,
			'User-Agent': 'MC-BRIDGE/1.0'
		}
	});

	ws.on('open', () => {
		console.log('[WS] 已连接');
        flushMsgQueue();
	});

	ws.on('close', (code, reason) => {
		console.log(`[WS] 连接中断 (代码: ${code})`);
		setTimeout(() => {
            if (msgQueue.length > 0) connect();
        }, 5000);
	});

	ws.on('error', (err) => {
		console.log('[WS] ERROR: ', err.message);
		ws.close();
	});
}

// deal with msg queue
function flushMsgQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (msgQueue.length > 0) {
        const msg = msgQueue.shift();
        const now = Date.now();
        const latency = (now - msg.time) / 1000;
        let finalText = msg.text;
        // note the latency
        if (latency > 5) {
            finalText += ` (delayed ${latency.toFixed(0)}s)`;
        }

        ws.send(finalText);
        console.log(`[Flush] ${finalText}`);
    }
    resetIdleTimer();
}

// send msg to chatroom
function sendToChatroom(text) {
    msgQueue.push({
        text: text,
        time: Date.now()
    });
	if (ws && ws.readyState === WebSocket.OPEN) {
        flushMsgQueue();
    } else {
        console.log(`[Queue] 未连接, 消息已存入队列 (当前积压: ${msgQueue.length})`);
        connect();
    }
}

// idle timer
function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log("[Idle] 已空闲 10min, 已中断 WebSocket 连线");
            ws.close();
        }
    }, 10 * 60 * 1000);
}

// get msg 
function startTailing() {
    console.log('[Tail] 正在运行...');
    
    // using Follow ('-F') mode
    // only get msg sent after bridge has started ('-n', '0')
    const tailProc = spawn('tail', ['-F', '-n', '0', CONFIG.LOG_FILE]);

    tailProc.stderr.on('data', (data) => {
        console.error(`[Tail] ERROR: ${data}`);
    });

    // using readline
    const rl = readline.createInterface({
        input: tailProc.stdout,
        terminal: false
    });

    rl.on('line', (line) => {
        handleLogLine(line);
    });

    tailProc.on('close', (code) => {
        console.log(`[Tail] 进程退出 (代码 ${code}), 尝试重启...`);
        setTimeout(startTailing, 2000);
    });
}

// Core REGEXPs
function handleLogLine(line) {
    // return if not include '/INFO]'
    if (!line.includes('/INFO]')) return;

    // async chat
    const chatMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Async Chat Thread - #\d+\/INFO\]: (?:\[[^\]]+\] )?<([^>]+)> (.+)/);
    if (chatMatch) {
        const player = chatMatch[1];
        const msg = chatMatch[2];
        sendToChatroom(`[CHAT] <${player}> ${msg}`);
        return;
    }

    // player joined the game
    const joinMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) joined the game/);
    if (joinMatch) {
        const player = joinMatch[1];
        sendToChatroom(`[INFO] ${player} joined the game`);
        return;
    }

    // player left game
    const leaveMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) left the game/);
    if (leaveMatch) {
        const player = leaveMatch[1];
        sendToChatroom(`[INFO] ${player} left the game`);
        return;
    }

    // auto welcome message
    const welcomeMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: Hey (\w+), sunshine! Just wanted to send a little virtual hug your way\. Hope your day is as awesome as you are! Have a fantastic time here on Salmonized Workspace!/);
    if (welcomeMatch) {
        const player = welcomeMatch[1];
        sendToChatroom(`[INFO] Hey ${player}, sunshine! Just wanted to send a little virtual hug your way. Hope your day is as awesome as you are! Have a fantastic time here on Salmonized Workspace!`);
        return;
    }

    // advancement / goal / challenge
    const advMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) (has made the advancement|has reached the goal|has completed the challenge) \[(.+)\]/);
    if (advMatch) {
        const player = advMatch[1];
        const action = advMatch[2];
        const advName = advMatch[3];
        sendToChatroom(`[INFO] ${player} ${action} [${advName}]`);
        return;
    }

    // death message
    const deathMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) ((?:was|walked|drowned|died|experienced|blew|hit|fell|went|burned|tried|discovered|froze|starved|suffocated|left|withered|didn't).*)/);
    if (deathMatch) {
        const player = deathMatch[1];
        const msg = deathMatch[2];
        sendToChatroom(`[INFO] ${player} ${msg}`);
        return;
    }
}

// start
connect();
startTailing();

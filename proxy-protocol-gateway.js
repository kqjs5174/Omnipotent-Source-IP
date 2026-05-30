"use strict";

const fs = require("fs");
const net = require("net");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { Duplex } = require("stream");
const { URL } = require("url");

// 用于记录 TLS socket 到 realIP 的映射
const pendingTlsSockets = [];

const CONFIG_PATH = process.argv[2] || "proxy-gateway.config.json";
const DEFAULT_CONFIG = {
  listenHost: "0.0.0.0",
  listenPort: 8080,
  sslEnabled: false,
  sslKeyPath: "server.key",
  sslCertPath: "server.crt",
  target: "http://127.0.0.1:23333",
  proxyProtocol: "optional",
  realIpHeader: "X-Real-IP",
  forwardedForHeader: "X-Forwarded-For",
  forwardedProtoHeader: "X-Forwarded-Proto",
  preserveHost: true,
  trustProxyProtocolFrom: [],
  firstPacketTimeoutMs: 5000,
  maxProxyHeaderBytes: 108,
  logLevel: "info",
  logRequests: true
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`找不到配置文件：${CONFIG_PATH}`);
    process.exit(1);
  }

  const config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  config.listenPort = Number(config.listenPort);
  config.targetUrl = new URL(config.target);
  config.targetIsHttps = config.targetUrl.protocol === "https:";
  config.targetPort = Number(config.targetUrl.port || (config.targetIsHttps ? 443 : 80));

  if (!["optional", "required", "disabled"].includes(config.proxyProtocol)) {
    throw new Error('proxyProtocol 必须是 "optional"、"required" 或 "disabled"');
  }
  if (!["debug", "info", "warn", "error", "silent"].includes(config.logLevel)) {
    throw new Error('logLevel 必须是 "debug"、"info"、"warn"、"error" 或 "silent"');
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
    throw new Error("listenPort 必须是有效的 TCP 端口");
  }

  // 解析SSL配置
  if (config.sslEnabled) {
    if (!fs.existsSync(config.sslKeyPath)) {
      throw new Error(`SSL key 文件不存在：${config.sslKeyPath}`);
    }
    if (!fs.existsSync(config.sslCertPath)) {
      throw new Error(`SSL cert 文件不存在：${config.sslCertPath}`);
    }
    config.sslKey = fs.readFileSync(config.sslKeyPath);
    config.sslCert = fs.readFileSync(config.sslCertPath);
  }

  return config;
}

const config = loadConfig();
const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99
};

function log(level, message) {
  if (LOG_LEVELS[level] < LOG_LEVELS[config.logLevel]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

function normalizeIp(ip) {
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function isTrustedProxyAddress(remoteAddress) {
  if (!config.trustProxyProtocolFrom || config.trustProxyProtocolFrom.length === 0) return true;
  const normalized = normalizeIp(remoteAddress);
  return config.trustProxyProtocolFrom.includes(normalized) || config.trustProxyProtocolFrom.includes(remoteAddress);
}

function parseProxyProtocolV1(buffer) {
  const max = Math.min(buffer.length, config.maxProxyHeaderBytes);
  const end = buffer.indexOf("\r\n");

  if (end === -1) {
    if (buffer.length > max) throw new Error("Proxy Protocol header is too long");
    return null;
  }

  if (end > max) throw new Error("Proxy Protocol header is too long");

  const line = buffer.subarray(0, end).toString("ascii");
  const parts = line.split(" ");
  if (parts.length < 2 || parts[0] !== "PROXY") throw new Error("Invalid Proxy Protocol header");

  if (parts[1] === "UNKNOWN") {
    return {
      sourceAddress: null,
      sourcePort: null,
      rest: buffer.subarray(end + 2)
    };
  }

  if (parts.length !== 6 || (parts[1] !== "TCP4" && parts[1] !== "TCP6")) {
    throw new Error("Unsupported Proxy Protocol v1 line");
  }

  const sourcePort = Number(parts[4]);
  if (!Number.isInteger(sourcePort) || sourcePort < 0 || sourcePort > 65535) {
    throw new Error("Invalid Proxy Protocol source port");
  }

  return {
    sourceAddress: parts[2],
    sourcePort,
    rest: buffer.subarray(end + 2)
  };
}

function parseProxyProtocolV2(buffer) {
  const signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
  if (buffer.length < 16) return null;
  if (!buffer.subarray(0, 12).equals(signature)) throw new Error("Invalid Proxy Protocol v2 signature");

  const versionCommand = buffer[12];
  const version = versionCommand >> 4;
  const command = versionCommand & 0x0f;
  const familyProtocol = buffer[13];
  const family = familyProtocol >> 4;
  const protocol = familyProtocol & 0x0f;
  const length = buffer.readUInt16BE(14);
  const totalLength = 16 + length;

  if (version !== 2) throw new Error("Invalid Proxy Protocol v2 version");
  if (buffer.length < totalLength) return null;

  const payload = buffer.subarray(16, totalLength);
  const rest = buffer.subarray(totalLength);

  if (command === 0x00) {
    return { sourceAddress: null, sourcePort: null, rest };
  }
  if (command !== 0x01) throw new Error("Unsupported Proxy Protocol v2 command");

  if (protocol !== 0x01 && protocol !== 0x02) {
    return { sourceAddress: null, sourcePort: null, rest };
  }

  if (family === 0x01) {
    if (payload.length < 12) throw new Error("Invalid Proxy Protocol v2 IPv4 address block");
    return {
      sourceAddress: `${payload[0]}.${payload[1]}.${payload[2]}.${payload[3]}`,
      sourcePort: payload.readUInt16BE(8),
      rest
    };
  }

  if (family === 0x02) {
    if (payload.length < 36) throw new Error("Invalid Proxy Protocol v2 IPv6 address block");
    const groups = [];
    for (let index = 0; index < 16; index += 2) {
      groups.push(payload.readUInt16BE(index).toString(16));
    }
    return {
      sourceAddress: groups.join(":"),
      sourcePort: payload.readUInt16BE(32),
      rest
    };
  }

  return { sourceAddress: null, sourcePort: null, rest };
}

function detectProxyHeader(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "PROXY") return "v1";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 12).equals(Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]))
  ) {
    return "v2";
  }
  return null;
}

function mayBePartialProxyHeader(buffer) {
  const v1Prefix = Buffer.from("PROXY", "ascii");
  const v2Prefix = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

  if (buffer.length < v1Prefix.length && v1Prefix.subarray(0, buffer.length).equals(buffer)) return true;
  if (buffer.length < v2Prefix.length && v2Prefix.subarray(0, buffer.length).equals(buffer)) return true;
  return false;
}

function closeWithHttpError(socket, statusCode, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function formatClient(socket) {
  return `${normalizeIp(socket.remoteAddress)}:${socket.remotePort || "-"}`;
}

function buildForwardHeaders(rawHeaders, clientIp, incomingSocket) {
  const headers = [];
  let hasRealIp = false;
  let hasForwardedFor = false;
  let hasForwardedProto = false;
  let hasConnection = false;
  let hasHost = false;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    const lower = name.toLowerCase();

    if (lower === config.realIpHeader.toLowerCase()) {
      headers.push(name, clientIp);
      hasRealIp = true;
      continue;
    }
    if (lower === config.forwardedForHeader.toLowerCase()) {
      headers.push(name, value ? `${value}, ${clientIp}` : clientIp);
      hasForwardedFor = true;
      continue;
    }
    if (lower === config.forwardedProtoHeader.toLowerCase()) {
      headers.push(name, "http");
      hasForwardedProto = true;
      continue;
    }
    if (lower === "host") {
      hasHost = true;
      headers.push(name, config.preserveHost ? value : config.targetUrl.host);
      continue;
    }
    if (lower === "connection") hasConnection = true;

    headers.push(name, value);
  }

  if (!hasHost) headers.push("Host", config.preserveHost ? incomingSocket.localAddress || config.targetUrl.host : config.targetUrl.host);
  if (!hasRealIp) headers.push(config.realIpHeader, clientIp);
  if (!hasForwardedFor) headers.push(config.forwardedForHeader, clientIp);
  if (!hasForwardedProto) headers.push(config.forwardedProtoHeader, "http");
  if (!hasConnection) headers.push("Connection", "close");

  return headers;
}

function forwardHttpRequest(req, res) {
  log("debug", `收到HTTP请求：${req.method} ${req.url}`);
  const clientIp = req.socket.proxyProtocolSourceAddress || normalizeIp(req.socket.remoteAddress);
  const transport = config.targetIsHttps ? https : http;
  const path = req.url.startsWith("/") ? req.url : `/${req.url}`;
  const options = {
    protocol: config.targetUrl.protocol,
    hostname: config.targetUrl.hostname,
    port: config.targetPort,
    method: req.method,
    path,
    headers: buildForwardHeaders(req.rawHeaders, clientIp, req.socket)
  };

  const upstream = transport.request(options, (upstreamRes) => {
    if (config.logRequests) {
      log("info", `请求完成：${req.method} ${req.url} 状态=${upstreamRes.statusCode || 0} 真实IP=${clientIp} 来源=${formatClient(req.socket)} 后端=${config.targetUrl.host}`);
    }
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, upstreamRes.rawHeaders);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    log("error", `HTTP 转发到后端失败：${error.message}`);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Gateway");
  });

  req.pipe(upstream);
}

function forwardUpgrade(req, clientSocket, head) {
  const clientIp = req.socket.proxyProtocolSourceAddress || normalizeIp(req.socket.remoteAddress);
  const headers = buildForwardHeaders(req.rawHeaders, clientIp, req.socket);
  const connect = config.targetIsHttps ? tls.connect : net.connect;
  const upstreamSocket = connect({
    host: config.targetUrl.hostname,
    port: config.targetPort,
    servername: config.targetUrl.hostname
  });

  upstreamSocket.on("connect", () => {
    if (config.logRequests) {
      log("info", `WebSocket 已接入：${req.url} 真实IP=${clientIp} 来源=${formatClient(req.socket)} 后端=${config.targetUrl.host}`);
    }
    const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    const headerLines = [];
    for (let index = 0; index < headers.length; index += 2) {
      headerLines.push(`${headers[index]}: ${headers[index + 1]}`);
    }
    upstreamSocket.write(requestLine + headerLines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  upstreamSocket.on("error", (error) => {
    log("error", `WebSocket 转发到后端失败：${error.message}`);
    closeWithHttpError(clientSocket, 502, "Bad Gateway");
  });
}

// 根据配置创建HTTP或HTTPS服务器
let httpServer;
let tlsServer;
const secureContext = config.sslEnabled ? tls.createSecureContext({
  key: config.sslKey,
  cert: config.sslCert
}) : null;

if (config.sslEnabled) {
  log("info", `启用HTTPS，监听端口 ${config.listenPort}`);
  httpServer = https.createServer({
    key: config.sslKey,
    cert: config.sslCert
  }, forwardHttpRequest);
  
  // 创建 TLS Server 用于处理通过 TCP server 的 socket
  tlsServer = tls.createServer({
    key: config.sslKey,
    cert: config.sslCert
  }, (tlsSocket) => {
    // 从待处理列表中获取真实IP
    if (pendingTlsSockets.length > 0) {
      const pending = pendingTlsSockets.shift();
      tlsSocket.proxyProtocolSourceAddress = pending.realIp;
    }
    httpServer.emit("secureConnection", tlsSocket);
  });
  
  tlsServer.on("tlsClientError", (error, tlsSocket) => {
    log("warn", `TLS 客户端错误：${error.message}`);
  });
} else {
  log("info", `启用HTTP，监听端口 ${config.listenPort}`);
  httpServer = http.createServer(forwardHttpRequest);
}
httpServer.on("upgrade", forwardUpgrade);
httpServer.on("clientError", (error, socket) => {
  log("warn", `HTTP 客户端请求异常：${error.message}`);
  closeWithHttpError(socket, 400, "Bad Request");
});

const tcpServer = net.createServer((socket) => {
  const remoteIp = normalizeIp(socket.remoteAddress);
  log("debug", `TCP 连接进入：来源=${formatClient(socket)}`);
  let chunks = [];
  let totalLength = 0;
  let settled = false;

  const timer = setTimeout(() => {
    if (!settled) {
      log("warn", `等待首包超时，已断开：来源=${remoteIp}`);
      socket.destroy();
    }
  }, config.firstPacketTimeoutMs);

  function handoff(buffer, clientIp) {
    settled = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    
    const realIp = clientIp || remoteIp;

    if (config.sslEnabled) {
      log("debug", `握手阶段：转交给 TLS Server，真实IP=${realIp}`);
      
      // 记录待处理的真实IP
      pendingTlsSockets.push({ realIp });
      
      // 创建一个 Duplex stream 来包装原始 socket，以便在 TLS 握手前注入 ClientHello 数据
      let bufferRead = false;
      const wrapper = new Duplex({
        read() {
          if (!bufferRead) {
            bufferRead = true;
            if (buffer.length > 0) {
              this.push(buffer);
            }
          }
        },
        write(chunk, encoding, callback) {
          return socket.write(chunk, callback);
        },
        destroy(error, callback) {
          socket.destroy();
          callback(error);
        }
      });

      // 监听原始 socket 的数据，转发到 wrapper
      socket.on("data", (chunk) => {
        if (!wrapper.destroyed) {
          wrapper.push(chunk);
        }
      });

      socket.on("end", () => {
        if (!wrapper.destroyed) {
          wrapper.push(null);
        }
      });

      socket.on("error", (error) => {
        if (!wrapper.destroyed) {
          wrapper.destroy(error);
        }
      });

      tlsServer.emit("connection", wrapper);
    } else {
      // HTTP 模式
      socket.proxyProtocolSourceAddress = realIp;
      if (buffer.length > 0) {
        socket.unshift(buffer);
      }
      httpServer.emit("connection", socket);
    }
  }

  function reject(statusCode, message) {
    settled = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    closeWithHttpError(socket, statusCode, message);
  }

  function onData(chunk) {
    chunks.push(chunk);
    totalLength += chunk.length;
    const buffer = Buffer.concat(chunks, totalLength);
    const detected = detectProxyHeader(buffer);

    // 调试日志：打印首包的前16字节
    if (!settled && config.logLevel === "debug") {
      const hex = buffer.slice(0, Math.min(16, buffer.length)).toString("hex");
      log("debug", `首包hex: ${hex}, 检测结果: ${detected}`);
    }

    try {
      if (config.proxyProtocol === "disabled") {
        handoff(buffer, remoteIp);
        return;
      }

      if (detected === "v2") {
        if (!isTrustedProxyAddress(socket.remoteAddress)) {
          log("warn", `拒绝未受信任的 Proxy Protocol v2 来源：${formatClient(socket)}`);
          reject(403, "Forbidden");
          return;
        }

        const parsed = parseProxyProtocolV2(buffer);
        if (!parsed) return;
        log("debug", `已解析 Proxy Protocol v2：来源=${formatClient(socket)} 真实IP=${parsed.sourceAddress || remoteIp}`);
        const rest = parsed.rest || Buffer.alloc(0);
        const preview = rest.length ? rest.slice(0, 8).toString("hex") : "empty";
        let typeHint = "unknown";
        if (rest.length) {
          const b = rest[0];
          if (b === 0x16) typeHint = "TLS (ClientHello)";
          else if (b === 0x80 || b === 0x00) typeHint = "SSLv2/legacy";
          else if (b === 0x47) typeHint = "HTTP (starts with 'G')";
          else if (b >= 0x20 && b <= 0x7e) typeHint = `ASCII '${String.fromCharCode(b)}'`;
          else typeHint = `0x${b.toString(16)}`;
        }
        log("debug", `Proxy v2 rest preview: ${preview} hint=${typeHint}`);
        handoff(rest, parsed.sourceAddress || remoteIp);
        return;
      }

      if (!detected && mayBePartialProxyHeader(buffer)) return;

      if (detected === "v1") {
        if (!isTrustedProxyAddress(socket.remoteAddress)) {
          log("warn", `拒绝未受信任的 Proxy Protocol v1 来源：${formatClient(socket)}`);
          reject(403, "Forbidden");
          return;
        }

        const parsed = parseProxyProtocolV1(buffer);
        if (!parsed) return;
        log("debug", `已解析 Proxy Protocol v1：来源=${formatClient(socket)} 真实IP=${parsed.sourceAddress || remoteIp}`);
        const rest = parsed.rest || Buffer.alloc(0);
        const preview = rest.length ? rest.slice(0, 8).toString("hex") : "empty";
        let typeHint = "unknown";
        if (rest.length) {
          const b = rest[0];
          if (b === 0x16) typeHint = "TLS (ClientHello)";
          else if (b === 0x80 || b === 0x00) typeHint = "SSLv2/legacy";
          else if (b === 0x47) typeHint = "HTTP (starts with 'G')";
          else if (b >= 0x20 && b <= 0x7e) typeHint = `ASCII '${String.fromCharCode(b)}'`;
          else typeHint = `0x${b.toString(16)}`;
        }
        log("debug", `Proxy v1 rest preview: ${preview} hint=${typeHint}`);
        handoff(rest, parsed.sourceAddress || remoteIp);
        return;
      }

      if (config.proxyProtocol === "required") {
        reject(400, "Proxy Protocol Required");
        return;
      }

      handoff(buffer, remoteIp);
    }
    catch (error) {
      log("warn", `Proxy Protocol 解析失败：${error.message} 来源=${remoteIp}`);
      reject(400, "Bad Proxy Protocol");
    }
  }

  socket.on("data", onData);
  socket.on("error", (error) => {
    log("warn", `TCP 连接异常：来源=${remoteIp} 错误=${error.message}`);
  });
});

tcpServer.on("error", (error) => {
  log("error", `网关服务启动/监听失败：${error.message}`);
  process.exit(1);
});

tcpServer.listen(config.listenPort, config.listenHost, () => {
  log("info", `网关已启动，正在监听 ${config.listenHost}:${config.listenPort}`);
  log("info", `后端面板地址：${config.target}`);
  log("info", `Proxy Protocol 模式：${config.proxyProtocol}`);
  log("info", `真实 IP 请求头：${config.realIpHeader}`);
  log("info", `受信任的 Proxy Protocol 来源：${config.trustProxyProtocolFrom.length ? config.trustProxyProtocolFrom.join(", ") : "全部来源"}`);
  log("info", `请求日志：${config.logRequests ? "已开启" : "已关闭"}`);
});

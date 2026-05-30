# 🌐 Omnipotent-Source-IP

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D14.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![Build Status](https://img.shields.io/badge/status-stable-success)

> **Proxy Protocol v1/v2 协议转换网关** — 为 frp 及其他代理工具提供源IP传递支持

一个高性能、功能完整的网关转换器，将 **Proxy Protocol v1/v2** 协议转换为标准的 **X-Real-IP** 和 **X-Forwarded-For** HTTP 请求头，让不支持 Proxy Protocol 的后端应用轻松获取真实客户端源IP。

## ✨ 核心特性

- 🔄 **双协议支持**：完整支持 Proxy Protocol v1 和 v2 协议
- 🛡️ **灵活配置**：支持 optional、required、disabled 三种模式
- 📡 **转换转发**：将 Proxy Protocol 转换为 X-Real-IP、X-Forwarded-For 等标准头
- 🔐 **安全认证**：支持信任名单，只接受特定上游代理的 Proxy Protocol
- 🚀 **高性能**：基于 Node.js，非阻塞 I/O，支持大并发
- 🔒 **HTTPS/TLS 支持**：完整的 SSL/TLS 支持和 WebSocket 升级处理
- 📊 **详细日志**：多级别日志记录，debug 模式下输出详细信息
- 🌐 **WebSocket 支持**：自动转发 WebSocket 升级请求，支持 socket.io 等实时框架
- 🎯 **IPv4/IPv6**：同时支持 IPv4 和 IPv6 地址解析

## 🎯 应用场景

| 场景 | 说明 |
|-----|------|
| **frp 反向代理** | frp 配置 Proxy Protocol，将真实 IP 转换为 HTTP 头 |
| **云负载均衡** | 阿里云 SLB、腾讯云 CLB 等使用 Proxy Protocol 传递真实 IP |
| **CDN 回源** | CDN 节点使用 Proxy Protocol，需要转换给后端应用 |
| **其他代理工具** | Nginx、HAProxy、EasyProxy 等反向代理 |
| **适配遗留应用** | MCSManager、Minecraft 服务器、应用面板等 |

## 📦 快速开始

### 1. 安装依赖

```bash
# 本项目仅依赖 Node.js 内置模块，无需额外依赖
node --version  # 确保 >= 14.0
```

### 2. 配置

编辑 `proxy-gateway.config.json`：

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 8080,
  "target": "http://127.0.0.1:23333",
  "proxyProtocol": "optional",
  "realIpHeader": "X-Real-IP",
  "forwardedForHeader": "X-Forwarded-For",
  "forwardedProtoHeader": "X-Forwarded-Proto",
  "preserveHost": true,
  "trustProxyProtocolFrom": [],
  "firstPacketTimeoutMs": 5000,
  "logLevel": "info",
  "logRequests": true
}
```

### 3. 启动网关

```bash
# 使用默认配置文件
node proxy-protocol-gateway.js

# 或指定自定义配置文件
node proxy-protocol-gateway.js custom-config.json
```

## ⚙️ 配置详解

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| **listenHost** | string | `0.0.0.0` | 网关监听地址 |
| **listenPort** | number | `8080` | 网关监听端口 (1-65535) |
| **target** | string | `http://127.0.0.1:23333` | 后端服务地址（HTTP/HTTPS） |
| **proxyProtocol** | string | `optional` | 协议模式：`optional`（可选）、`required`（必需）、`disabled`（禁用） |
| **realIpHeader** | string | `X-Real-IP` | 源 IP 请求头名称 |
| **forwardedForHeader** | string | `X-Forwarded-For` | 转发链路请求头名称 |
| **forwardedProtoHeader** | string | `X-Forwarded-Proto` | 协议请求头名称 |
| **preserveHost** | boolean | `true` | 是否保留原始 Host 头 |
| **trustProxyProtocolFrom** | array | `[]` | 信任的上游代理 IP 列表（空表示信任所有） |
| **firstPacketTimeoutMs** | number | `5000` | 等待首包超时时间（毫秒）|
| **maxProxyHeaderBytes** | number | `108` | Proxy Protocol 头最大字节数 |
| **logLevel** | string | `info` | 日志级别：`debug`、`info`、`warn`、`error`、`silent` |
| **logRequests** | boolean | `true` | 是否记录转发的请求日志 |
| **sslEnabled** | boolean | `false` | 是否启用 HTTPS |
| **sslKeyPath** | string | `server.key` | SSL 私钥文件路径 |
| **sslCertPath** | string | `server.crt` | SSL 证书文件路径 |

## 📋 使用示例

### 示例 1：frp 代理场景

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 8080,
  "target": "http://127.0.0.1:3000",
  "proxyProtocol": "required",
  "trustProxyProtocolFrom": ["127.0.0.1"],
  "realIpHeader": "X-Real-IP",
  "logRequests": true
}
```

配置 frp 启用 Proxy Protocol，网关自动转换为 X-Real-IP 头

### 示例 2：多上游代理（负载均衡+frp）

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 8080,
  "target": "http://127.0.0.1:23333",
  "proxyProtocol": "required",
  "trustProxyProtocolFrom": ["127.0.0.1", "10.0.0.10"],
  "realIpHeader": "X-Real-IP",
  "forwardedForHeader": "X-Forwarded-For",
  "logLevel": "info"
}
```

### 示例 3：调试模式（详细日志）

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 9090,
  "target": "http://127.0.0.1:3000",
  "proxyProtocol": "optional",
  "logLevel": "debug",
  "logRequests": true
}
```

启动网关后，将看到详细的 Proxy Protocol 解析日志。

### 示例 4：HTTPS + frp

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 443,
  "target": "http://127.0.0.1:3000",
  "proxyProtocol": "required",
  "sslEnabled": true,
  "sslKeyPath": "/etc/ssl/private/server.key",
  "sslCertPath": "/etc/ssl/certs/server.crt",
  "realIpHeader": "X-Real-IP",
  "logRequests": true
}
```

## 📊 工作流程

```
┌─────────────────────────────┐
│   frp / 负载均衡器 / CDN    │
│  (发送 Proxy Protocol)       │
└──────────────┬──────────────┘
               │ TCP 连接
               │ Proxy Protocol v1/v2 + HTTP/WebSocket
               ▼
┌─────────────────────────────┐
│ Omnipotent-Source-IP        │
│ (协议解析与转换)             │
│ - 解析 Proxy Protocol       │
│ - 提取真实源IP              │
│ - 转换为 HTTP 头            │
└──────────────┬──────────────┘
               │ TCP 连接
               │ HTTP/WebSocket + X-Real-IP
               ▼
┌─────────────────────────────┐
│   后端应用服务              │
│ (获取真实源IP)              │
│ - MCSManager                │
│ - Web 应用                  │
│ - 应用面板                  │
└─────────────────────────────┘
```

## 🔧 Proxy Protocol 协议支持

### Proxy Protocol v1

**格式**：文本格式，以 `PROXY` 开头

```
PROXY TCP4 192.0.2.250 203.0.113.42 56324 443\r\n
[HTTP 请求内容]
```

**特点**：
- 简单易读
- 文本格式
- IPv4 和 IPv6 支持

### Proxy Protocol v2

**格式**：二进制格式，以特殊字节序列开头

```
\r\n\r\n\x00\r\nQUIT\n[版本/命令][地址族/协议][长度][地址信息]
[HTTP/其他协议内容]
```

**特点**：
- 二进制格式，更紧凑
- 支持 TLV（Tag-Length-Value）扩展
- 性能更好

## 📝 日志示例

### 信息级别（info）
```
[2024-01-15T10:30:45.123Z] [INFO] 网关已启动，正在监听 0.0.0.0:8080
[2024-01-15T10:30:46.456Z] [INFO] 请求完成：GET / 状态=200 真实IP=192.0.2.100 来源=203.0.113.5:12345
```

### 调试级别（debug）
```
[2024-01-15T10:30:46.450Z] [DEBUG] TCP 连接进入：来源=203.0.113.5:12345
[2024-01-15T10:30:46.451Z] [DEBUG] 首包hex: 0d0a0d0a000d0a515549540a210111000c检测结果: v2
[2024-01-15T10:30:46.452Z] [DEBUG] 已解析 Proxy Protocol v2：来源=203.0.113.5:12345 真实IP=192.0.2.100
```

## 🔒 安全建议

### ⚠️ 生产环境检查清单

- [ ] 设置 `proxyProtocol: "required"`，强制使用 Proxy Protocol
- [ ] 配置 `trustProxyProtocolFrom`，只信任特定的上游代理 IP
- [ ] 仅在内网允许访问后端服务（绑定到 `127.0.0.1`）
- [ ] 启用日志记录和监控，定期检查异常请求
- [ ] 根据业务需求调整 `firstPacketTimeoutMs` 超时时间
- [ ] 使用 HTTPS，启用 `sslEnabled` 并提供有效的证书

### 配置示例（推荐）

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 8080,
  "proxyProtocol": "required",
  "trustProxyProtocolFrom": ["10.0.0.0/8", "127.0.0.1"],
  "realIpHeader": "X-Real-IP",
  "logLevel": "warn",
  "logRequests": true
}
```

## 🐛 故障排查

### 问题 1：无法获取真实 IP

**原因**：后端应用未配置正确的反向代理头

**解决**：
1. 检查 `realIpHeader` 配置是否正确
2. 确保后端应用配置了对应的反向代理头
3. 查看日志中的源 IP 是否被正确解析

```bash
# 启用调试模式查看日志
"logLevel": "debug"
```

### 问题 2：连接被拒绝

**原因**：可能是：
- 上游代理不在 `trustProxyProtocolFrom` 信任列表中
- `proxyProtocol` 配置为 `required`，但客户端未发送 Proxy Protocol

**解决**：
```json
{
  "proxyProtocol": "optional",  // 改为可选
  "logLevel": "debug"           // 启用调试模式查看原因
}
```

### 问题 3：WebSocket 连接失败

**原因**：网关未正确转发升级请求头

**解决**：
- 确保配置中 `preserveHost` 为 `true`
- 检查后端应用支持 WebSocket
- 查看日志确认升级请求是否被正确转发

## 📦 文件说明

| 文件 | 说明 |
|-----|------|
| `proxy-protocol-gateway.js` | 网关主程序 |
| `proxy-gateway.config.json` | 配置文件示例 |
| `README.md` | 项目文档 |

## 🚀 性能参数

- **支持并发连接**：取决于操作系统和 Node.js 配置，通常支持数千个并发连接
- **内存占用**：基础内存 ~50MB，建议 256MB+ 
- **CPU 占用**：低，主要是 I/O 转发

## 🔄 版本兼容性

| Node.js 版本 | 状态 |
|-------------|------|
| >= 14.0 | ✅ 支持 |
| 12.x | ⚠️ 可能支持 |
| < 12.0 | ❌ 不支持 |

## 📄 许可证

MIT License - 详见 LICENSE 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📞 技术支持

有问题？请检查：
1. 配置是否正确（格式、端口等）
2. 后端应用是否支持配置的反向代理头
3. 防火墙是否阻止了连接
4. 启用 `logLevel: "debug"` 查看详细日志

---

<div align="center">

**⭐ 如果这个项目对你有帮助，请给个 Star！**

Made with ❤️ for the open source community

</div>

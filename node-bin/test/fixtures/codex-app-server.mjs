#!/usr/bin/env node
import net from "node:net";

if (!process.env.AGENCY_FAKE_CODEX_SOCKET) throw new Error("Missing fake app-server socket");
const socket = net.createConnection(process.env.AGENCY_FAKE_CODEX_SOCKET);
socket.on("connect", () => socket.write(JSON.stringify({ fixturePid: process.pid }) + "\n"));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", () => { process.exitCode = 1; process.stdin.destroy(); });
socket.on("close", () => process.stdin.destroy());
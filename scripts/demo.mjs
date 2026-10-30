import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNode, root } from "./config.mjs";

assertNode();

const apiPath = join(root, "dist", "api.json");
let api;
try {
  api = JSON.parse(await readFile(apiPath, "utf8"));
} catch {
  throw new Error("dist/api.json não encontrado. Rode npm run build && npm run provision.");
}

const baseUrl = String(api.baseUrl ?? "").replace(/\/$/, "");
if (!baseUrl) {
  throw new Error("dist/api.json sem baseUrl");
}

const confirmed = await placeOrder(
  {
    customerName: "Ana",
    items: [{ sku: "CADERNO", qty: 2, unitCents: 1500 }],
  },
  "CONFIRMED",
);
const rejected = await placeOrder(
  {
    customerName: "Bruno",
    items: [{ sku: "MESA", qty: 1, unitCents: 60_000 }],
  },
  "REJECTED",
);

console.log(`CONFIRMADO ${confirmed.orderId} totalCents=${confirmed.totalCents} reason=${confirmed.reason}`);
console.log(`RECUSADO   ${rejected.orderId} totalCents=${rejected.totalCents} reason=${rejected.reason}`);

async function placeOrder(order, expected) {
  const created = await createOrder(order);
  console.log(`pedido ${created.orderId} criado, aguardando ${expected}`);
  return waitForStatus(created.orderId, expected);
}

async function createOrder(order) {
  let last = "sem resposta";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(order),
    });
    const unwrapped = await unwrap(response);
    if (unwrapped.status >= 200 && unwrapped.status < 300 && unwrapped.body?.orderId) {
      return unwrapped.body;
    }
    last = `HTTP ${unwrapped.status} ${JSON.stringify(unwrapped.body)}`;
    if (unwrapped.status < 500) {
      throw new Error(`falha ao criar pedido: ${last}`);
    }
    console.log(`tentativa ${attempt} falhou (${unwrapped.status}); novo envio em 3s`);
    await sleep(3000);
  }
  throw new Error(`falha ao criar pedido: ${last}`);
}

async function waitForStatus(orderId, expected) {
  const deadline = Date.now() + 120_000;
  let last = "sem resposta";
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/orders/${orderId}`);
    const unwrapped = await unwrap(response);
    last = JSON.stringify(unwrapped.body);
    const status = unwrapped.body?.status;
    if (unwrapped.status === 200 && status === expected) {
      return unwrapped.body;
    }
    if (unwrapped.status === 200 && (status === "CONFIRMED" || status === "REJECTED")) {
      throw new Error(`pedido ${orderId} terminou ${status}, esperado ${expected}: ${last}`);
    }
    await sleep(1000);
  }
  throw new Error(`pedido ${orderId} não chegou a ${expected}. último estado: ${last}`);
}

async function unwrap(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { status: response.status, body: { raw: text } };
  }
  if (parsed && typeof parsed.statusCode === "number" && "body" in parsed) {
    const inner = typeof parsed.body === "string" ? tryParse(parsed.body) : parsed.body;
    return { status: parsed.statusCode, body: inner };
  }
  return { status: response.status, body: parsed };
}

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

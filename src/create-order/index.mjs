import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { documentClient, env, sqsClient } from "../shared/aws.mjs";
import { isOptions, json } from "../shared/http.mjs";
import { bindContext, log } from "../shared/log.mjs";

export async function handler(event, context) {
  bindContext(context);
  if (isOptions(event)) {
    return json(200, {});
  }
  log("inicio", { method: event.httpMethod ?? null, path: event.path ?? null });

  let payload;
  try {
    payload = parseBody(event);
  } catch {
    log("rejeitado", { message: "JSON inválido" });
    return json(400, { message: "JSON inválido" });
  }

  const message = invalidMessage(payload);
  if (message) {
    log("rejeitado", { message });
    return json(400, { message });
  }

  const now = new Date().toISOString();
  const order = {
    orderId: randomUUID(),
    customerName: payload.customerName.trim(),
    items: payload.items,
    totalCents: payload.items.reduce((sum, item) => sum + item.qty * item.unitCents, 0),
    status: "RECEIVED",
    createdAt: now,
    updatedAt: now,
    trail: [
      { step: "create-order", at: now, detail: "PutItem com status RECEIVED" },
      { step: "sqs", at: now, detail: "SendMessage com o orderId" },
    ],
  };

  await documentClient().send(
    new PutCommand({
      TableName: env("TABLE_NAME"),
      Item: order,
    }),
  );
  log("gravado", { orderId: order.orderId, totalCents: order.totalCents, status: order.status });

  await sqsClient().send(
    new SendMessageCommand({
      QueueUrl: env("QUEUE_URL"),
      MessageBody: JSON.stringify({ orderId: order.orderId }),
    }),
  );
  log("enfileirado", { orderId: order.orderId });

  return json(201, order);
}

function parseBody(event) {
  if (event?.body == null || event.body === "") {
    return {};
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

function invalidMessage(payload) {
  if (typeof payload?.customerName !== "string" || payload.customerName.trim() === "") {
    return "customerName é obrigatório";
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return "items deve ter ao menos um item";
  }
  for (const item of payload.items) {
    if (typeof item?.sku !== "string" || item.sku.trim() === "") {
      return "sku é obrigatório";
    }
    if (!Number.isInteger(item.qty)) {
      return "qty deve ser um inteiro";
    }
    if (!Number.isInteger(item.unitCents) || item.unitCents < 0) {
      return "unitCents deve ser um inteiro maior ou igual a zero";
    }
  }
  return null;
}

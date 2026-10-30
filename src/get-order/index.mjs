import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, env } from "../shared/aws.mjs";
import { isOptions, json } from "../shared/http.mjs";
import { bindContext, log } from "../shared/log.mjs";

export async function handler(event, context) {
  bindContext(context);
  if (isOptions(event)) {
    return json(200, {});
  }
  const orderId = orderIdFrom(event);
  log("inicio", { orderId: orderId ?? null, path: event.path ?? null });
  if (!orderId) {
    log("rejeitado", { message: "orderId é obrigatório" });
    return json(400, { message: "orderId é obrigatório" });
  }

  const result = await documentClient().send(
    new GetCommand({
      TableName: env("TABLE_NAME"),
      Key: { orderId },
    }),
  );

  if (!result.Item) {
    log("ausente", { orderId });
    return json(404, { message: "pedido não encontrado" });
  }

  log("encontrado", { orderId, status: result.Item.status });
  return json(200, result.Item);
}

function orderIdFrom(event) {
  const fromPath = event.pathParameters?.orderId;
  if (fromPath) {
    return decodeURIComponent(fromPath);
  }
  const path = event.path ?? event.rawPath ?? "";
  const match = path.match(/\/orders\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

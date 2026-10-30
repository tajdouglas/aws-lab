import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, env } from "../shared/aws.mjs";
import { bindContext, log } from "../shared/log.mjs";

const LIMIT_CENTS = 50_000;

export async function handler(event, context) {
  bindContext(context);
  const records = event.Records ?? [];
  log("inicio", { records: records.length });
  const failures = [];

  for (const record of records) {
    try {
      await processRecord(record);
    } catch (error) {
      log("falhou", { messageId: record.messageId, error: error.message });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function processRecord(record) {
  const { orderId } = JSON.parse(record.body);
  const tableName = env("TABLE_NAME");
  const current = await documentClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { orderId },
    }),
  );

  if (!current.Item) {
    log("ausente", { orderId, messageId: record.messageId });
    return;
  }

  const decision = decide(current.Item);
  const updatedAt = new Date().toISOString();
  log("decidido", {
    orderId,
    messageId: record.messageId,
    totalCents: current.Item.totalCents,
    status: decision.status,
    reason: decision.reason,
  });

  try {
    await documentClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: { orderId },
        ConditionExpression: "#status = :received",
        UpdateExpression:
          "SET #status = :status, reason = :reason, updatedAt = :updatedAt, trail = list_append(if_not_exists(trail, :empty), :hop)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":received": "RECEIVED",
          ":status": decision.status,
          ":reason": decision.reason,
          ":updatedAt": updatedAt,
          ":empty": [],
          ":hop": [
            {
              step: "process-order",
              at: updatedAt,
              status: decision.status,
              reason: decision.reason,
            },
          ],
        },
      }),
    );
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      log("ja-processado", { orderId });
      return;
    }
    throw error;
  }

  log("atualizado", { orderId, status: decision.status });
}

function decide(order) {
  if (order.items.some((item) => item.qty <= 0)) {
    return { status: "REJECTED", reason: "quantidade inválida" };
  }
  if (order.totalCents > LIMIT_CENTS) {
    return { status: "REJECTED", reason: "total acima de R$ 500,00" };
  }
  return { status: "CONFIRMED", reason: "pedido confirmado" };
}
